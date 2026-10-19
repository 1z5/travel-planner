import { describe, expect, it } from "vitest";
import {
  COST_CATEGORIES,
  budgetTone,
  formatCny,
  summarizeBudget,
} from "@/lib/budget";
import { finalizePlan } from "@/lib/validate";
import type { Plan, PlanDay, PlanInput, PlanSpot, SpotType } from "@/lib/types";
import fixture from "../../scripts/fixture-plan.json";

// 预算透视纯函数单测。重点钉住三件事：
// 1) 数字自洽：类别金额之和 = total、整数百分比之和 = 100（最大余数法）；
// 2) 语义口径：状态阈值与 lib/validate.ts 的 1.05 / 0.8 完全一致（边界不能漂）；
// 3) 诚实降级：无预算 / 预算为 0 / 数据不一致 / 未知类型，都不猜、不掩盖。

// ---------- 测试数据构造 ----------

function spot(type: SpotType | string, costCny: number, name = "测试点"): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: type as SpotType,
    name,
    area: "测试区",
    durationMin: 60,
    costCny,
    reason: "单测用",
  };
}

function makePlan(
  days: Array<{ day?: number; spots: PlanSpot[] }>,
  opts: { totalCostCny?: number; budgetCny?: number } = {},
): Plan {
  const planDays: PlanDay[] = days.map((d, i) => ({
    day: d.day ?? i + 1,
    theme: `第 ${i + 1} 天`,
    spots: d.spots,
    transitMin: 0,
    dailyCostCny: d.spots.reduce((s, x) => s + x.costCny, 0),
  }));
  const total =
    opts.totalCostCny ?? planDays.reduce((s, d) => s + d.dailyCostCny, 0);
  return {
    city: "测试城",
    summary: "测试行程",
    days: planDays,
    totalCostCny: total,
    tips: [],
    warnings: [],
    verified: true,
    ...(opts.budgetCny !== undefined ? { budgetCny: opts.budgetCny } : {}),
  };
}

/** 一份六类别齐全的行程：总额 1800 */
function fullPlan(budgetCny?: number): Plan {
  return makePlan(
    [
      {
        spots: [
          spot("hotel", 1200, "酒店"),
          spot("food", 400, "餐厅"),
          spot("sight", 100, "景点"),
          spot("transport", 50, "打车"),
          spot("shopping", 30, "特产"),
          spot("activity", 20, "演出"),
        ],
      },
    ],
    { budgetCny },
  );
}

// ---------- 分类与百分比 ----------

describe("summarizeBudget：分类构成", () => {
  it("类别按金额降序；金额之和 = total；整数百分比之和恰好 100", () => {
    const s = summarizeBudget(fullPlan());
    expect(s.total).toBe(1800);
    expect(s.categories.map((c) => c.type)).toEqual([
      "hotel",
      "food",
      "sight",
      "transport",
      "shopping",
      "activity",
    ]);
    expect(s.categories.reduce((n, c) => n + c.amount, 0)).toBe(s.total);
    expect(s.categories.reduce((n, c) => n + c.pct, 0)).toBe(100);
    expect(s.categories[0]).toMatchObject({ label: "住宿", amount: 1200 });
    expect(s.largest).toMatchObject({ type: "hotel", label: "住宿", amount: 1200 });
  });

  it("固定分类表：6 个真实类型 + 其它兜底，标签/颜色齐全且类型不重复", () => {
    expect(COST_CATEGORIES).toHaveLength(7);
    expect(new Set(COST_CATEGORIES.map((c) => c.type)).size).toBe(7);
    const byType = Object.fromEntries(COST_CATEGORIES.map((c) => [c.type, c]));
    expect(byType.hotel.label).toBe("住宿");
    expect(byType.food.label).toBe("餐饮");
    expect(byType.sight.label).toBe("景点门票");
    expect(byType.transport.label).toBe("交通");
    expect(byType.shopping.label).toBe("购物");
    expect(byType.activity.label).toBe("体验活动");
    expect(byType.other.label).toBe("其它");
    for (const c of COST_CATEGORIES) expect(c.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("0 元类别被剔除：免费项不进图例（否则图例全是 0%）", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("hotel", 0), spot("food", 100), spot("sight", 0)] }]),
    );
    expect(s.total).toBe(100);
    expect(s.categories.map((c) => c.type)).toEqual(["food"]);
    expect(s.categories[0].count).toBe(1);
    // 免费项仍算进该类别的「条目数」，但类别本身金额为 0 时整条剔除
    expect(s.categories.some((c) => c.amount === 0)).toBe(false);
  });

  it("count 统计该类别的全部条目（含免费项），免费项不改变金额", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("sight", 100), spot("sight", 0), spot("sight", 0)] }]),
    );
    expect(s.categories[0]).toMatchObject({ type: "sight", amount: 100, count: 3, pct: 100 });
  });

  it("未知 type 归「其它」，金额不丢（类别之和仍 = total）", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 60), spot("nightlife" as SpotType, 40)] }]),
    );
    const other = s.categories.find((c) => c.type === "other");
    expect(other).toMatchObject({ label: "其它", amount: 40, pct: 40 });
    expect(s.categories.reduce((n, c) => n + c.amount, 0)).toBe(s.total);
    expect(s.categories.reduce((n, c) => n + c.pct, 0)).toBe(100);
  });

  it("最大余数法：三等分不会出现 99%/101%", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 1), spot("sight", 1), spot("transport", 1)] }]),
    );
    expect(s.categories.map((c) => c.pct)).toEqual([34, 33, 33]);
    expect(s.categories.reduce((n, c) => n + c.pct, 0)).toBe(100);
  });

  it("极端占比：不足 1% 的类别 pct 取 0，但金额如实保留（整数百分比的如实呈现）", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("hotel", 1999), spot("food", 1)] }]),
    );
    expect(s.categories.map((c) => c.type)).toEqual(["hotel", "food"]);
    expect(s.categories[0].pct).toBe(100);
    expect(s.categories[1]).toMatchObject({ amount: 1, pct: 0 });
    expect(s.categories.reduce((n, c) => n + c.pct, 0)).toBe(100);
  });

  it("金额先取整再求和（避免浮点尾巴）", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 10.4), spot("sight", 10.6)] }]),
    );
    expect(s.total).toBe(21);
    expect(s.categories.map((c) => c.amount).sort((a, b) => a - b)).toEqual([10, 11]);
  });
});

// ---------- 预算使用率四态（+ 未知） ----------

describe("summarizeBudget：预算状态", () => {
  const oneSpotPlan = (cost: number, budgetCny?: number) =>
    makePlan([{ spots: [spot("food", cost)] }], { budgetCny });

  it("达标：80% ≤ 使用率 ≤ 100%（含边界 80% / 100%）", () => {
    expect(summarizeBudget(oneSpotPlan(830, 1000))).toMatchObject({
      status: "on-target",
      usedPct: 83,
    });
    expect(summarizeBudget(oneSpotPlan(800, 1000)).status).toBe("on-target");
    expect(summarizeBudget(oneSpotPlan(1000, 1000))).toMatchObject({
      status: "on-target",
      usedPct: 100,
    });
  });

  it("宽松：使用率 < 80%（79.9% 即 <80%）", () => {
    expect(summarizeBudget(oneSpotPlan(799, 1000))).toMatchObject({
      status: "under",
      usedPct: 80, // 展示四舍五入为 80%，但判定用未取整比值 79.9%——与 validate 同口径
    });
    const s = summarizeBudget(oneSpotPlan(500, 1000));
    expect(s.status).toBe("under");
    expect(s.notes[0]).toContain("预算宽松");
  });

  it("偏紧：100% < 使用率 ≤ 105%（边界 105% 归偏紧，>105% 才超支——与 validate 严格对齐）", () => {
    expect(summarizeBudget(oneSpotPlan(1020, 1000))).toMatchObject({
      status: "tight",
      usedPct: 102,
    });
    // 恰好 105%：validate 用 grandTotal > budget*1.05 才预警，故此处也是 tight
    expect(summarizeBudget(oneSpotPlan(1050, 1000)).status).toBe("tight");
    // 105.1%：越过预警线
    expect(summarizeBudget(oneSpotPlan(1051, 1000)).status).toBe("over");
    expect(summarizeBudget(oneSpotPlan(1020, 1000)).notes[0]).toContain("比预算多");
  });

  it("超支：> 105%，人话结论给出超出金额与百分比", () => {
    const s = summarizeBudget(oneSpotPlan(1120, 1000));
    expect(s).toMatchObject({ status: "over", usedPct: 112 });
    expect(s.notes[0]).toBe("比预算多 ¥120（+12%）——建议优先压缩餐饮");
    expect(budgetTone(s.status)).toBe("err");
  });

  it("无预算：status=unknown，usedPct 缺失，notes[0] 讲最大开销而不是编使用率", () => {
    const s = summarizeBudget(fullPlan());
    expect(s.status).toBe("unknown");
    expect(s.budget).toBeUndefined();
    expect(s.usedPct).toBeUndefined();
    // 无预算时结论优先讲「钱花在哪」，再补一句为什么没有使用率
    expect(s.notes[0]).toContain("住宿占 67%");
    expect(s.notes[1]).toContain("未记录预算");
    expect(budgetTone(s.status)).toBe("muted");
    // perDay 不猜预算占比
    expect(s.perDay[0].pctOfBudget).toBeUndefined();
  });

  it("预算为 0 / 负数：视为无效预算，notes 第一句就说清原因，不除零、不出 Infinity", () => {
    for (const bad of [0, -100]) {
      const s = summarizeBudget(
        makePlan([{ spots: [spot("food", 100)] }], { budgetCny: bad }),
      );
      expect(s.status).toBe("unknown");
      expect(s.budget).toBeUndefined();
      expect(s.usedPct).toBeUndefined();
      expect(Number.isFinite(s.total)).toBe(true);
      expect(s.notes[0]).toContain("无法计算使用率");
    }
  });

  it("预算为非有限值（NaN）：等同缺失，按「未记录预算」降级，不除零", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 100)] }], { budgetCny: Number.NaN }),
    );
    expect(s.status).toBe("unknown");
    expect(s.budget).toBeUndefined();
    expect(s.usedPct).toBeUndefined();
    expect(Number.isFinite(s.total)).toBe(true);
    expect(s.notes.some((n) => n.includes("未记录预算"))).toBe(true);
  });

  it("有预算但行程 0 花费：不把「没花钱」说成「预算宽松」，如实提示可能数据缺失", () => {
    const s = summarizeBudget(makePlan([{ spots: [] }], { budgetCny: 1000 }));
    expect(s.status).toBe("under");
    expect(s.total).toBe(0);
    expect(s.notes[0]).toContain("没有记录花费");
    expect(s.notes[0]).not.toContain("宽松");
  });
});

// ---------- 每日花费 ----------

describe("summarizeBudget：perDay", () => {
  it("每天金额汇总正确；有预算时附带当天占预算百分比", () => {
    const s = summarizeBudget(
      makePlan(
        [
          { spots: [spot("hotel", 600), spot("food", 100)] },
          { spots: [spot("food", 200)] },
        ],
        { budgetCny: 1000 },
      ),
    );
    expect(s.perDay).toEqual([
      { day: 1, amount: 700, pctOfBudget: 70 },
      { day: 2, amount: 200, pctOfBudget: 20 },
    ]);
  });

  it("空行程：不崩，total=0、categories 空、notes 如实说明", () => {
    const s = summarizeBudget(makePlan([]));
    expect(s).toMatchObject({ total: 0, status: "unknown", categories: [], perDay: [] });
    expect(s.largest).toBeUndefined();
    expect(s.usedPct).toBeUndefined();
    expect(s.notes[0]).toContain("没有记录花费");
    expect(s).not.toHaveProperty("budget");
  });
});

// ---------- 数据诚实性 ----------

describe("summarizeBudget：数据自洽性", () => {
  it("行程记录总价与逐项合计不一致：以逐项合计为准并在 notes 如实说明", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 100)] }], { totalCostCny: 150 }),
    );
    expect(s.total).toBe(100);
    expect(s.notes.some((n) => n.includes("不一致"))).toBe(true);
    expect(s.notes.join("\n")).toContain("¥150");
  });

  it("负数/非数字花费：按 0 计并留下数据异常提示，不静默吞掉", () => {
    const s = summarizeBudget(
      makePlan([{ spots: [spot("food", 100), spot("sight", -20), spot("sight", Number.NaN)] }], {
        totalCostCny: 100,
      }),
    );
    expect(s.total).toBe(100);
    expect(s.notes.some((n) => n.includes("异常"))).toBe(true);
  });

  it("notes 最多 3 条（不刷屏）", () => {
    const plan = fullPlan(1000);
    plan.totalCostCny = 9999; // 制造不一致
    plan.days[0].spots.push(spot("food", -5));
    const s = summarizeBudget(plan);
    expect(s.notes.length).toBeLessThanOrEqual(3);
    // 无论附加几条数据说明，notes[0] 永远是用户结论
    expect(s.notes[0]).toContain("预算");
  });

  it("formatCny 千分位 + 取整（组件与 notes 共用同一格式）", () => {
    expect(formatCny(1200)).toBe("¥1,200");
    expect(formatCny(1925.4)).toBe("¥1,925");
    expect(formatCny(Number.NaN)).toBe("¥0");
  });
});

// ---------- 真实 fixture（真实生成数据，防止口径漂移） ----------

describe("summarizeBudget：真实 fixture（苏州 3 天，总价 1925）", () => {
  const plan = fixture as unknown as Plan;

  it("分类金额/占比/排序与真实数据一致，百分比之和 100", () => {
    const s = summarizeBudget(plan);
    expect(s.total).toBe(1925);
    expect(s.categories.map((c) => [c.type, c.amount, c.pct])).toEqual([
      ["hotel", 1200, 62],
      ["food", 425, 22],
      ["sight", 280, 15],
      ["activity", 20, 1],
    ]);
    expect(s.categories.reduce((n, c) => n + c.pct, 0)).toBe(100);
    expect(s.categories.reduce((n, c) => n + c.amount, 0)).toBe(1925);
    expect(s.largest).toMatchObject({ type: "hotel", amount: 1200, pct: 62 });
    // 16 个行程条目全部归入类别（含免费项），一条不丢
    expect(s.categories.reduce((n, c) => n + c.count, 0)).toBe(16);
  });

  it("fixture 不含 budgetCny：诚实降级为 unknown，只讲实际构成", () => {
    const s = summarizeBudget(plan);
    expect(s.status).toBe("unknown");
    expect(s.budget).toBeUndefined();
    expect(s.usedPct).toBeUndefined();
    expect(s.notes[0]).toContain("住宿占 62%");
    expect(s.notes.some((n) => n.includes("未记录预算"))).toBe(true);
    expect(s.notes.some((n) => n.includes("超预算"))).toBe(false);
  });

  it("每日花费：首日含住宿 1385，后两天各 270", () => {
    const s = summarizeBudget(plan);
    expect(s.perDay.map((d) => d.amount)).toEqual([1385, 270, 270]);
  });

  it("数据链路：finalizePlan 回填 budgetCny 后，使用率立刻可算（上游不断链）", () => {
    const p = makePlan([{ spots: [spot("food", 100)] }]);
    const input: PlanInput = { city: "测试城", days: 1, budget: 1200, preferences: [] };
    finalizePlan(p, input, {
      warnings: [],
      unverified: [],
      transitUnknownDays: [],
      grandTotal: 100,
      missCount: 0,
      poiTotal: 0,
    });
    expect(p.budgetCny).toBe(1200);
    const s = summarizeBudget(p);
    expect(s).toMatchObject({ total: 100, budget: 1200, usedPct: 8, status: "under" });
  });
});
