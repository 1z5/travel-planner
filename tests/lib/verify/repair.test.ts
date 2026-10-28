import { describe, expect, it } from "vitest";
import { repairDocument } from "@/lib/verify/repair";
import { RULES } from "@/lib/verify/rules";
import { getSample } from "@/lib/verify/samples";
import type { DocLeg, DocSpot, TripCheckDocument } from "@/lib/verify/types";

const NOW = new Date("2026-10-28T10:00:00.000Z");

function spot(name: string, time: string, extra: Partial<DocSpot> = {}): DocSpot {
  return { name, time, type: "sight", durationMin: 60, costCny: 10, ...extra };
}

function doc(
  days: TripCheckDocument["days"],
  extra: Partial<TripCheckDocument> = {},
): TripCheckDocument {
  return { specVersion: "trip-check/0.1", days, ...extra };
}

function legs(...items: Array<{ from: string; to: string; durationMin?: number }>): DocLeg[] {
  return items.map((l) => ({
    from: l.from,
    to: l.to,
    mode: "walking",
    ...(l.durationMin !== undefined ? { durationMin: l.durationMin } : {}),
  }));
}

describe("Trip Check Repair · 能修的（确定性、不编造）", () => {
  it("时间重叠：顺延后一个点，消除 TC-C102，分数回到 A", () => {
    const input = doc([
      {
        day: 1,
        spots: [spot("拙政园", "09:00-11:00"), spot("平江路", "10:30-12:00")],
      },
    ]);
    const r = repairDocument(input, {}, NOW);
    expect(r.before.stats.blocking).toBe(1);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].ruleId).toBe("TC-C102");
    expect(r.applied[0].spot).toBe("平江路");
    // 产品侧要把变更套回 Plan：必须带原始下标与前后时刻（不是只给一句 detail）
    expect(r.applied[0].spotIndex).toBe(1);
    expect(r.applied[0].from).toBe("10:30-12:00");
    expect(r.applied[0].to).toBe("11:00-12:30");
    expect(r.document.days[0].spots[1].time).toBe("11:00-12:30");
    expect(r.after.stats.blocking).toBe(0);
    expect(r.after.verdict.consistency.score).toBe(100);
    expect(r.after.verdict.consistency.grade).toBe("A");
    expect(r.delta.blockingReduced).toBe(1);
    expect(r.delta.score).toBeGreaterThan(0);
    expect(r.delta.improved).toBe(true);
  });

  it("路段接不上：按真实耗时顺延，消除 TC-C103（不按 0 分钟假设）", () => {
    const input = doc([
      {
        day: 1,
        spots: [spot("A", "09:00-10:00", { durationMin: 60 }), spot("B", "10:10-11:10")],
        legs: legs({ from: "A", to: "B", durationMin: 40 }),
      },
    ]);
    const r = repairDocument(input, {}, NOW);
    expect(r.before.stats.blocking).toBe(1);
    expect(r.applied[0].ruleId).toBe("TC-C103");
    expect(r.document.days[0].spots[1].time).toBe("10:40-11:40");
    expect(r.after.stats.blocking).toBe(0);
    // 修复后相邻关系刚好留足 40 分钟
    expect(r.after.issues.some((i) => i.ruleId === "TC-C103")).toBe(false);
  });

  it("同一天重复点位：删掉后出现的重复项，保留第一条", () => {
    const input = doc([
      {
        day: 1,
        spots: [
          spot("西湖", "09:00-10:00"),
          spot("灵隐寺", "10:30-11:30"),
          spot("西湖", "13:00-14:00"),
        ],
      },
    ]);
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].ruleId).toBe("TC-C109");
    expect(r.document.days[0].spots.map((s) => s.name)).toEqual(["西湖", "灵隐寺"]);
    expect(r.after.issues.some((i) => i.ruleId === "TC-C109")).toBe(false);
    expect(r.delta.improved).toBe(true);
  });

  it("多天分别修复：只改有问题的那天，其它天原样", () => {
    const input = doc([
      { day: 1, spots: [spot("A", "09:00-10:00"), spot("B", "09:30-10:30")] },
      { day: 2, spots: [spot("C", "09:00-10:00"), spot("D", "10:30-11:30")] },
    ]);
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].day).toBe(1);
    expect(r.document.days[1].spots[1].time).toBe("10:30-11:30");
  });

  it("原始文档不被修改（修复返回新对象）", () => {
    const input = doc([{ day: 1, spots: [spot("A", "09:00-10:00"), spot("B", "09:30-10:30")] }]);
    const snapshot = JSON.stringify(input);
    repairDocument(input, {}, NOW);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("同一输入 + 同一注入时间 → 修复结果与前后报告完全一致（可复现）", () => {
    const input = doc([
      {
        day: 1,
        spots: [spot("A", "09:00-10:00"), spot("B", "09:30-10:30")],
        legs: legs({ from: "A", to: "B", durationMin: 20 }),
      },
    ]);
    expect(repairDocument(input, {}, NOW)).toEqual(repairDocument(input, {}, NOW));
  });
});

describe("Trip Check Repair · 修不了的必须如实说", () => {
  it("干净文档：不产生任何修复、delta 为 0、不谎报改善", () => {
    const sample = getSample("verified")!.document;
    const r = repairDocument(sample, {}, NOW);
    expect(r.applied).toHaveLength(0);
    expect(r.delta.score).toBe(0);
    expect(r.delta.blockingReduced).toBe(0);
    expect(r.delta.improved).toBe(false);
    expect(r.document).toEqual(sample);
    expect(r.remainingRuleIds).toEqual([...new Set(r.after.issues.map((i) => i.ruleId))].sort());
  });

  it("时间格式非法：不猜正确时刻，记入 unrepairable（TC-C101）", () => {
    const input = doc([{ day: 1, spots: [spot("A", "早上九点"), spot("B", "10:00-11:00")] }]);
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(0);
    expect(r.unrepairable.some((u) => u.ruleId === "TC-C101")).toBe(true);
    expect(r.document.days[0].spots[0].time).toBe("早上九点");
  });

  it("顺延会超过 24:00 → 整天回滚，不产生半截修复", () => {
    const input = doc([
      {
        day: 1,
        spots: [spot("夜场A", "22:00-23:00"), spot("夜场B", "23:10-23:50")],
        legs: legs({ from: "夜场A", to: "夜场B", durationMin: 90 }),
      },
    ]);
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(0);
    expect(r.document.days[0].spots[1].time).toBe("23:10-23:50");
    expect(r.unrepairable.some((u) => u.ruleId === "TC-C103")).toBe(true);
    expect(r.delta.improved).toBe(false);
  });

  it("缺路段数据：不编造通勤耗时，TC-C104 如实列为不可修", () => {
    const input = doc([{ day: 1, spots: [spot("A", "09:00-10:00"), spot("B", "12:00-13:00")] }]);
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(0);
    expect(r.unrepairable.some((u) => u.ruleId === "TC-C104")).toBe(true);
  });

  it("超预算：涉及取舍，不自动删点（TC-C108 记入不可修）", () => {
    const input = doc([{ day: 1, spots: [spot("贵餐厅", "09:00-10:00", { costCny: 500 })] }], {
      budgetCny: 100,
    });
    const r = repairDocument(input, {}, NOW);
    expect(r.applied).toHaveLength(0);
    expect(r.document.days[0].spots).toHaveLength(1);
    expect(r.unrepairable.some((u) => u.ruleId === "TC-C108")).toBe(true);
  });

  it("事实问题（未核验/未命中）不修，也不把 facts 状态改好", () => {
    const sample = getSample("unverified")!.document;
    const r = repairDocument(sample, {}, NOW);
    expect(r.before.verdict.facts.state).toBe("unverified");
    expect(r.after.verdict.facts.state).toBe("unverified");
    expect(r.unrepairable.some((u) => u.ruleId === "TC-F201")).toBe(true);
  });
});

describe("Trip Check Repair · 不改变事实（只动时间/重复项）", () => {
  it("除 time 与重复项外，文档其余字段逐一保持不变（不编造地点/营业时间/路段）", () => {
    const input = getSample("blocked")!.document;
    const r = repairDocument(input, {}, NOW);
    // 地点名、类型、营业时间、核验状态、路段数据都不能被修复器碰
    const stripTimes = (d: TripCheckDocument) =>
      d.days.map((day) => ({
        ...day,
        spots: day.spots.map(({ time: _time, ...rest }) => rest),
      }));
    expect(stripTimes(r.document)).toEqual(stripTimes(input));
    // 路段（from/to/duration）完全一致
    expect(r.document.days.map((d) => d.legs)).toEqual(input.days.map((d) => d.legs));
  });

  it("规则元信息：只有 C102/C103/C109 声明可机械修复（其余必须人工）", () => {
    const mechanical = Object.values(RULES)
      .filter((rule) => rule.mechanicalFix)
      .map((rule) => `${rule.id}:${rule.mechanicalFix}`)
      .sort();
    expect(mechanical).toEqual(["TC-C102:retime", "TC-C103:retime", "TC-C109:dedupe"]);
  });
});
