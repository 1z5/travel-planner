import { describe, expect, it } from "vitest";
import { verifyDocument } from "@/lib/verify/engine";
import { RULES } from "@/lib/verify/rules";
import { getSample, TRIP_CHECK_SAMPLES } from "@/lib/verify/samples";
import { TRIP_CHECK_ENGINE_VERSION, type TripCheckDocument } from "@/lib/verify/types";

// 固定「当前时间」：engine 只把它写进 checkedAt，不参与判定——注入后报告可完全复现
const FIXED = new Date("2026-10-28T10:00:00.000Z");

function verify(doc: TripCheckDocument, options?: Parameters<typeof verifyDocument>[1]) {
  return verifyDocument(doc, options ?? {}, FIXED);
}

function sample(id: "verified" | "blocked" | "unverified"): TripCheckDocument {
  const found = getSample(id);
  if (!found) throw new Error(`sample ${id} missing`);
  return found.document;
}

describe("Trip Check engine · 两轴结论", () => {
  it("已核验示例：结构 A 级 + 事实 verified + overall ok", () => {
    const r = verify(sample("verified"));
    expect(r.verdict.consistency.grade).toBe("A");
    expect(r.verdict.consistency.score).toBe(100);
    expect(r.verdict.facts.state).toBe("verified");
    expect(r.verdict.overall).toBe("ok");
    expect(r.stats.blocking).toBe(0);
    expect(r.verdict.consistency.summary).toContain("未发现阻断");
  });

  it("有问题的示例：闭馆 + 时间重叠 + 地点未命中 → blocking，结构 D 级", () => {
    const r = verify(sample("blocked"));
    expect(r.verdict.overall).toBe("blocking");
    expect(r.verdict.consistency.grade).toBe("D");
    const rules = r.issues.map((i) => i.ruleId);
    expect(rules).toContain("TC-C102"); // 时间重叠
    expect(rules).toContain("TC-F202"); // 地点未命中
    expect(rules).toContain("TC-F204"); // 周一闭馆
    expect(r.verdict.facts.state).toBe("partial"); // 有查过的、也有没查的
  });

  it("未核验示例：结构 A 级但 facts unverified，overall 不冒充 ok", () => {
    const r = verify(sample("unverified"));
    expect(r.verdict.consistency.grade).toBe("A");
    expect(r.verdict.facts.state).toBe("unverified");
    expect(r.verdict.overall).toBe("unverified");
    expect(r.issues.some((i) => i.ruleId === "TC-C104")).toBe(true);
  });

  it("三份示例都只引用注册表里的规则（不允许野规则 ID）", () => {
    for (const s of TRIP_CHECK_SAMPLES) {
      for (const issue of verify(s.document).issues) {
        expect(RULES[issue.ruleId], `${s.id} 出现未注册规则 ${issue.ruleId}`).toBeTruthy();
      }
    }
  });
});

describe("Trip Check engine · 结构规则", () => {
  it("C103：路段耗时不够时判「时间接不上」并给出缺口数字", () => {
    const doc: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "A", time: "09:00-10:00", durationMin: 60, costCny: 0 },
            { name: "B", time: "10:10-11:00", durationMin: 50, costCny: 0 },
          ],
          legs: [{ from: "A", to: "B", durationMin: 40 }],
        },
      ],
    };
    const r = verify(doc);
    const issue = r.issues.find((i) => i.ruleId === "TC-C103");
    expect(issue).toBeTruthy();
    expect(issue?.severity).toBe("blocking");
    expect(issue?.evidence.gapMinutes).toBe(10);
    expect(issue?.evidence.needMinutes).toBe(40);
    expect(r.verdict.consistency.grade).toBe("D"); // 阻断级扣 45 分 → 跌破 60
  });

  it("C101：时间格式非法时不猜时间，只报格式问题", () => {
    const r = verify({
      specVersion: "trip-check/0.1",
      days: [{ day: 1, spots: [{ name: "A", time: "早上九点", durationMin: 60, costCny: 0 }] }],
    });
    expect(r.issues.some((i) => i.ruleId === "TC-C101")).toBe(true);
    expect(r.issues.some((i) => i.ruleId === "TC-C102")).toBe(false);
  });

  it("C108：预算超出 5% 弹性线才告警", () => {
    const base: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      budgetCny: 100,
      days: [
        {
          day: 1,
          spots: [{ name: "A", time: "09:00-10:00", durationMin: 60, costCny: 120 }],
        },
      ],
    };
    expect(verify(base).issues.some((i) => i.ruleId === "TC-C108")).toBe(true);
    // 104 元在 100×1.05=105 的弹性内：不报
    const within: TripCheckDocument = {
      ...base,
      days: [
        { day: 1, spots: [{ name: "A", time: "09:00-10:00", durationMin: 60, costCny: 104 }] },
      ],
    };
    expect(verify(within).issues.some((i) => i.ruleId === "TC-C108")).toBe(false);
  });

  it("C105：缺时长/花费时跳过判定，不用 0 补齐", () => {
    const r = verify({
      specVersion: "trip-check/0.1",
      days: [{ day: 1, spots: [{ name: "A", time: "09:00-10:00" }] }],
    });
    expect(r.issues.some((i) => i.ruleId === "TC-C105")).toBe(true);
    // 只有一个点：没有路段、没有可判节奏的数据，不应因此误报 C107
    expect(r.issues.some((i) => i.ruleId === "TC-C107")).toBe(false);
  });

  it("C107：节奏上限随口径变化（relaxed 比 packed 更容易超）", () => {
    const doc: TripCheckDocument = {
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "A", time: "09:00-15:00", durationMin: 360, costCny: 0 },
            { name: "B", time: "15:30-22:00", durationMin: 390, costCny: 0 },
          ],
          legs: [{ from: "A", to: "B", durationMin: 30 }],
        },
      ],
    };
    // 合计 360+390+30 = 780 分钟：packed 上限 780 → 不超；relaxed 480 → 超
    expect(verify(doc, { pace: "packed" }).issues.some((i) => i.ruleId === "TC-C107")).toBe(false);
    const relaxed = verify(doc, { pace: "relaxed" });
    const issue = relaxed.issues.find((i) => i.ruleId === "TC-C107");
    expect(issue?.evidence.minutes).toBe(780);
    expect(issue?.evidence.limitMinutes).toBe(480);
  });

  it("C110/C109：空白天与同一天重复点位各自报一次", () => {
    const empty = verify({ specVersion: "trip-check/0.1", days: [{ day: 1, spots: [] }] });
    expect(empty.issues.some((i) => i.ruleId === "TC-C110")).toBe(true);

    const dup = verify({
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "西湖", time: "09:00-10:00", durationMin: 60, costCny: 0 },
            { name: "西湖", time: "10:30-11:30", durationMin: 60, costCny: 0 },
          ],
          legs: [{ from: "西湖", to: "西湖", durationMin: 10 }],
        },
      ],
    });
    expect(dup.issues.some((i) => i.ruleId === "TC-C109")).toBe(true);
  });

  it("C106：当天通勤合计超过 2 小时才判偏长", () => {
    const doc = (legMin: number): TripCheckDocument => ({
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            { name: "A", time: "08:00-09:00", durationMin: 60, costCny: 0 },
            { name: "B", time: "09:10-10:00", durationMin: 50, costCny: 0 },
            { name: "C", time: "10:20-11:00", durationMin: 40, costCny: 0 },
          ],
          legs: [
            { from: "A", to: "B", durationMin: legMin },
            { from: "B", to: "C", durationMin: legMin },
          ],
        },
      ],
    });
    expect(verify(doc(70)).issues.some((i) => i.ruleId === "TC-C106")).toBe(true); // 140 > 120
    expect(verify(doc(30)).issues.some((i) => i.ruleId === "TC-C106")).toBe(false); // 60
  });
});

describe("Trip Check engine · 事实规则", () => {
  it("F202：existence=miss 是 blocking（地点查不到），与 source error 严格区分", () => {
    const miss = verify({
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            {
              name: "不存在的地方",
              time: "09:00-10:00",
              durationMin: 60,
              costCny: 0,
              verification: { existence: "miss" },
            },
          ],
        },
      ],
    });
    expect(miss.issues.some((i) => i.ruleId === "TC-F202")).toBe(true);

    const error = verify({
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [
            {
              name: "查询失败的地方",
              time: "09:00-10:00",
              durationMin: 60,
              costCny: 0,
              verification: { existence: "error" },
            },
          ],
        },
      ],
    });
    expect(error.issues.some((i) => i.ruleId === "TC-F202")).toBe(false);
    expect(error.issues.some((i) => i.ruleId === "TC-F205")).toBe(true);
    // error 是「不知道」，不能算 blocking
    expect(error.verdict.overall).not.toBe("blocking");
  });

  it("F204：有营业时间原文 + 日期时判闭馆（附原因）", () => {
    const r = verify(sample("blocked"));
    const issue = r.issues.find((i) => i.ruleId === "TC-F204");
    expect(issue).toBeTruthy();
    expect(issue?.evidence.spot).toBe("苏州博物馆");
    expect(issue?.evidence.date).toBe("2026-11-02");
    expect(issue?.detail).toContain("闭馆");
  });

  it("F201/F203：没声明核验来源 → 聚合提示，不伪装成已验证", () => {
    const r = verify(sample("unverified"));
    const f201 = r.issues.find((i) => i.ruleId === "TC-F201");
    const f203 = r.issues.find((i) => i.ruleId === "TC-F203");
    expect(f201?.evidence.count).toBe(2);
    expect(f203?.evidence.count).toBe(2);
    expect(r.verdict.facts.coverage.poiNotChecked).toBe(2);
  });

  it("facts 覆盖率：存在性 hit/miss 都算「查过」，not_checked 不算", () => {
    const r = verify(sample("blocked"));
    const c = r.verdict.facts.coverage;
    expect(c.poiTotal).toBe(3);
    expect(c.poiChecked).toBe(3); // 2 hit + 1 miss
    expect(c.poiHit).toBe(2);
    expect(c.poiMiss).toBe(1);
    expect(c.poiNotChecked).toBe(0);
    expect(c.routesTotal).toBe(2);
    expect(c.routesChecked).toBe(0); // 故意没有 legs
  });
});

describe("Trip Check engine · 可复现与健壮性", () => {
  it("同一输入 + 同一注入时间 → 报告逐字节一致（可复算前提）", () => {
    const doc = sample("verified");
    expect(verify(doc)).toEqual(verify(doc));
  });

  it("换注入时间只改 checkedAt，不改任何判定（时间不参与判定）", () => {
    const doc = sample("verified");
    const a = verifyDocument(doc, {}, new Date("2026-10-28T00:00:00.000Z"));
    const b = verifyDocument(doc, {}, new Date("2027-01-01T00:00:00.000Z"));
    const strip = (r: typeof a) => {
      const { checkedAt: _checkedAt, ...rest } = r;
      return rest;
    };
    expect(strip(a)).toEqual(strip(b));
  });

  it("不修改入参（引擎只读）", () => {
    const doc = sample("blocked");
    const snapshot = JSON.stringify(doc);
    verify(doc);
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it("问题排序：blocking 在前，其次 warning，再 info", () => {
    const r = verify(sample("blocked"));
    const weights = r.issues.map((i) =>
      i.severity === "blocking" ? 0 : i.severity === "warning" ? 1 : 2,
    );
    expect(weights).toEqual([...weights].sort((a, b) => a - b));
  });

  it("报告带引擎/规则集版本，规则清单完整", () => {
    const r = verify(sample("verified"));
    expect(r.engine.name).toBe("trip-check");
    expect(r.engine.version).toBe(TRIP_CHECK_ENGINE_VERSION);
    expect(r.ruleset.ruleIds).toContain("TC-C104");
    expect(r.specVersion).toBe("trip-check/0.1");
  });
});
