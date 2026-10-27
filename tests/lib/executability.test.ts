import { describe, expect, it } from "vitest";
import type { Plan, PlanSpot } from "@/lib/types";
import { executabilityOf, formatCheckedAt } from "@/lib/executability";

// 可执行性评分：把体检结论收敛成用户能一眼看懂的 A/B/C/D + 证据。
// 这里守住评分契约：MOCK/草稿不评假分、扣分表可对账、证据字段完整。

function spot(over: Partial<PlanSpot> = {}): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:30",
    type: "sight",
    name: "拙政园",
    area: "姑苏区",
    durationMin: 90,
    costCny: 80,
    reason: "经典园林",
    ...over,
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    summary: "3 天古城园林",
    days: [
      {
        day: 1,
        theme: "古城",
        spots: [spot({ location: "120.6,31.3" }), spot({ location: "120.61,31.31" })],
        transitMin: 30,
        dailyCostCny: 300,
        legs: [
          {
            from: "拙政园",
            to: "平江路",
            mode: "walking",
            distanceM: 800,
            durationSec: 600,
            steps: ["向东步行"],
          },
        ],
      },
    ],
    totalCostCny: 1000,
    budgetCny: 2000,
    tips: [],
    warnings: [],
    verified: true,
    verification: "ok",
    ...over,
  };
}

describe("executabilityOf", () => {
  it("已核验且无问题 → A / 100，证据链完整", () => {
    const r = executabilityOf(plan({ verifiedAt: 1_700_000_000_000 }));
    expect(r.state).toBe("scored");
    expect(r.score).toBe(100);
    expect(r.grade).toBe("A");
    expect(r.verifiedSpots).toBe(2);
    expect(r.unverifiedSpots).toBe(0);
    expect(r.realLegs).toBe(1);
    expect(r.checkedAt).toBe(1_700_000_000_000);
    expect(r.summary).toContain("体检未发现阻断问题");
  });

  it("时间接不上 + 营业不符 → 硬问题计数、降级、分类可对账", () => {
    const r = executabilityOf(
      plan({
        warnings: [
          "第 1 天有 2 段「时间接不上」：如「拙政园」结束到「平江路」只有 10 分钟，但步行约需 20 分钟——可用「一键顺延」重排当天时间轴",
          "第 1 天「苏州博物馆」计划 16:15-17:15，但 营业时间 09:00-17:00，你 16:15 到，营业时间对不上、可能进不去，建议用「一键顺延」调整时间",
          "第 1 天站点间通勤约 3 小时，偏长，可能存在绕路，建议合并同区域景点",
        ],
      }),
    );
    expect(r.state).toBe("scored");
    expect(r.hardIssues).toBe(2);
    // 100 - 时间轴15 - 营业15 - 绕路8 = 62 → C
    expect(r.score).toBe(62);
    expect(r.grade).toBe("C");
    expect(r.categories.map((c) => c.tag)).toEqual(["时间轴", "营业", "绕路"]);
    expect(r.summary).toContain("2 处会直接影响行程");
  });

  it("同一类问题扣分有上限（10 条未验真不会把分数扣穿）", () => {
    const warnings = Array.from(
      { length: 10 },
      (_, i) => `第 1 天「某地点${i}」未在高德检索到，可能名称有误或已关闭`,
    );
    const r = executabilityOf(plan({ warnings }));
    // 未验真：单条 10 分、每类上限 30 → 100-30 = 70
    expect(r.score).toBe(70);
    expect(r.categories[0]).toMatchObject({ tag: "未验真", count: 10, points: 30 });
  });

  it("MOCK / 未核验：不给分数（打 A 是骗人）", () => {
    const r = executabilityOf(plan({ verified: false, verification: "mock" }));
    expect(r.state).toBe("unverified");
    expect(r.score).toBeNull();
    expect(r.grade).toBeNull();
    expect(r.summary).toContain("没有调用高德核验");
  });

  it("草稿 / 生成中：状态为 pending，不评半成品", () => {
    for (const over of [
      { draft: true },
      { verification: "pending" as const },
      { draft: true, draftKind: "fast" as const, verification: "pending" as const },
    ]) {
      const r = executabilityOf(plan(over));
      expect(r.state).toBe("pending");
      expect(r.score).toBeNull();
      expect(r.gradeLabel).toBe("核验中");
    }
  });

  it("部分点位未核验时，summary 如实说「还有 N 个点位未核验」", () => {
    const p = plan();
    p.days[0]!.spots = [spot({ location: "120.6,31.3" }), spot({ name: "待核实的地点" })];
    const r = executabilityOf(p);
    expect(r.unverifiedSpots).toBe(1);
    expect(r.summary).toContain("还有 1 个点位未核验");
  });

  it("不修改传入的 plan（纯函数）", () => {
    const p = plan();
    const before = JSON.stringify(p);
    executabilityOf(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("formatCheckedAt", () => {
  it("固定上海时区格式化（避免 SSR/CSR 水合不一致）", () => {
    // UTC 2026-10-26 13:30 = 上海 21:30
    expect(formatCheckedAt(Date.UTC(2026, 9, 26, 13, 30))).toContain("21:30");
  });
});
