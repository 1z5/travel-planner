import { describe, expect, it } from "vitest";
import { computeTripReport } from "@/lib/trip-report";
import type { Plan, PlanDay, PlanLeg, PlanSpot, SpotType, TransportMode } from "@/lib/types";
import fixture from "../../scripts/fixture-plan.json";

// 旅程报告纯函数单测。重点钉住四件事：
// 1) 统计全部可溯源：站点数/分类数/花费/路程都来自 plan 真实字段（含真实
//    fixture 的数字，防口径漂移）；
// 2) 缺失即缺省：无 legs → distanceKm/walkDistanceKm 不存在（不是 0）；
// 3) 去重口径：同站多天 = 一个站点、多笔花费（两个维度各自诚实）；
// 4) status 的时区口径：todayIso 由调用方按本地时区给出，三种分支 + 日期
//    边界（首日/末日/次日）必须判对，缺日期 → unknown（不猜）。

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

function leg(from: string, to: string, mode: TransportMode, distanceM: number): PlanLeg {
  return { from, to, mode, distanceM, durationSec: 600, steps: [] };
}

interface DaySpec {
  day?: number;
  spots: PlanSpot[];
  legs?: PlanLeg[];
}

function makePlan(
  days: DaySpec[],
  opts: { startDate?: string; endDate?: string; totalCostCny?: number } = {},
): Plan {
  const planDays: PlanDay[] = days.map((d, i) => ({
    day: d.day ?? i + 1,
    theme: `第 ${i + 1} 天`,
    spots: d.spots,
    transitMin: 0,
    dailyCostCny: d.spots.reduce((s, x) => s + x.costCny, 0),
    ...(d.legs ? { legs: d.legs } : {}),
  }));
  return {
    city: "测试城",
    summary: "测试行程",
    days: planDays,
    totalCostCny: opts.totalCostCny ?? planDays.reduce((s, d) => s + d.dailyCostCny, 0),
    tips: [],
    warnings: [],
    verified: false,
    ...(opts.startDate !== undefined ? { startDate: opts.startDate } : {}),
    ...(opts.endDate !== undefined ? { endDate: opts.endDate } : {}),
  };
}

/** 两天、带真实路段（driving）的齐全行程：Day1 三段 3.8 公里，Day2 一段 1.2 公里 */
function fullPlan(opts: Parameters<typeof makePlan>[1] = {}): Plan {
  return makePlan(
    [
      {
        spots: [
          spot("sight", 90, "测试景点"),
          spot("food", 35, "测试面馆"),
          spot("activity", 0, "测试老街"),
          spot("hotel", 1200, "测试酒店"),
        ],
        legs: [
          leg("测试景点", "测试面馆", "driving", 1500),
          leg("测试面馆", "测试老街", "driving", 2300),
        ],
      },
      {
        spots: [spot("sight", 100, "测试山"), spot("food", 80, "测试菜馆")],
        legs: [leg("测试山", "测试菜馆", "driving", 1234)],
      },
    ],
    opts,
  );
}

// ---------- 统计字段（齐全数据） ----------

describe("computeTripReport：齐全数据全字段", () => {
  const report = computeTripReport(
    fullPlan({ startDate: "2026-10-10", endDate: "2026-10-11" }),
    "2026-10-12", // 已结束
  );

  it("站点去重后计数与分类计数来自真实字段", () => {
    expect(report.spotCount).toBe(6);
    expect(report.sightCount).toBe(2);
    expect(report.foodCount).toBe(2);
  });

  it("天数与日期区间如实回传", () => {
    expect(report.days).toBe(2);
    expect(report.startDate).toBe("2026-10-10");
    expect(report.endDate).toBe("2026-10-11");
  });

  it("总花费为逐项合计（与 budget.ts 同口径，不采信可能过期的 totalCostCny）", () => {
    expect(report.totalCostCny).toBe(90 + 35 + 0 + 1200 + 100 + 80);
    // 逐项合计与 plan.totalCostCny 不一致时也以逐项为准
    const drifted = fullPlan({
      startDate: "2026-10-10",
      endDate: "2026-10-11",
      totalCostCny: 9999,
    });
    expect(computeTripReport(drifted).totalCostCny).toBe(1505);
  });

  it("路程为所有 legs 距离合计（一位小数）", () => {
    // 1500 + 2300 + 1234 = 5034 米 → 5.0 公里（一位小数，不是 5）
    expect(report.distanceKm).toBe(5);
    // driving 模式没有步行段：字段不存在（不是 0）
    expect(report.walkDistanceKm).toBeUndefined();
  });

  it("站点列表含名字/类型/花费，用于清单展示", () => {
    expect(report.spots).toHaveLength(6);
    const food = report.spots.find((s) => s.name === "测试面馆");
    expect(food).toMatchObject({ type: "food", costCny: 35, day: 1 });
  });
});

describe("computeTripReport：无 legs → 距离字段缺省", () => {
  it("MOCK 模式/旧行程没有 legs：distanceKm 与 walkDistanceKm 都不存在", () => {
    const report = computeTripReport(makePlan([{ spots: [spot("sight", 90, "测试景点")] }]));
    expect(report.distanceKm).toBeUndefined();
    expect(report.walkDistanceKm).toBeUndefined();
    expect("distanceKm" in report).toBe(false);
  });

  it("legs 存在但距离字段全部非法：同样视为没有路程数据", () => {
    const report = computeTripReport(
      makePlan([
        {
          spots: [spot("sight", 90, "测试景点")],
          legs: [leg("测试景点", "测试景点", "driving", Number.NaN)],
        },
      ]),
    );
    expect(report.distanceKm).toBeUndefined();
  });

  it("步行模式：walkDistanceKm 为 walking legs 合计", () => {
    const report = computeTripReport(
      makePlan([
        {
          spots: [spot("sight", 90, "测试景点"), spot("food", 35, "测试面馆")],
          legs: [leg("测试景点", "测试面馆", "walking", 1234)],
        },
      ]),
    );
    expect(report.distanceKm).toBe(1.2);
    expect(report.walkDistanceKm).toBe(1.2);
  });

  it("混合模式（部分步行）：只有 walking 段计入步行距离", () => {
    const report = computeTripReport(
      makePlan([
        {
          spots: [spot("sight", 90, "A"), spot("food", 35, "B"), spot("sight", 20, "C")],
          legs: [leg("A", "B", "walking", 1000), leg("B", "C", "driving", 3000)],
        },
      ]),
    );
    expect(report.distanceKm).toBe(4);
    expect(report.walkDistanceKm).toBe(1);
  });
});

// ---------- 真实 fixture（真实生成数据，防止口径漂移） ----------

describe("computeTripReport：真实 fixture（苏州 3 天，总价 1925）", () => {
  const plan = fixture as unknown as Plan;
  const report = computeTripReport({ ...plan, startDate: "2026-10-10", endDate: "2026-10-12" });

  it("16 个站点去重后全部计入（fixture 无重名）", () => {
    expect(report.spotCount).toBe(16);
    expect(report.sightCount).toBe(6);
    expect(report.foodCount).toBe(6);
    expect(report.totalCostCny).toBe(1925);
  });

  it("餐饮清单覆盖 6 家真实餐厅（来自真实 POI 名）", () => {
    const foods = report.spots.filter((s) => s.type === "food").map((s) => s.name);
    expect(foods).toEqual([
      "姑苏桥·文人苏式面馆",
      "桃花源记",
      "石家饭店",
      "协和菜馆",
      "同里状元居",
      "老苏州茶酒楼",
    ]);
  });

  it("旧数据没有 budgetCny：花费仍按逐项合计照常得出", () => {
    // fixture 本身就没有 budgetCny——花费统计与预算字段无关
    expect("budgetCny" in plan).toBe(false);
    expect(report.totalCostCny).toBe(1925);
  });
});

// ---------- 去重口径 ----------

describe("computeTripReport：去重口径", () => {
  it("同一家店出现在两天：算一个站点、两笔花费", () => {
    const report = computeTripReport(
      makePlan([
        { spots: [spot("food", 35, "老苏州茶酒楼")] },
        { spots: [spot("food", 35, "老苏州茶酒楼")] },
      ]),
    );
    expect(report.spotCount).toBe(1);
    expect(report.foodCount).toBe(1);
    // 花费按实际条目计：真的吃了两顿
    expect(report.totalCostCny).toBe(70);
    // 站点只保留第一次出现（day 指向首次出现那天）
    expect(report.spots).toHaveLength(1);
    expect(report.spots[0].day).toBe(1);
  });
});

// ---------- status：三种分支 + 日期边界 ----------

describe("computeTripReport：status 三态与日期边界", () => {
  const plan = fullPlan({ startDate: "2026-10-10", endDate: "2026-10-11" });

  it("今天早于出发日 → upcoming", () => {
    expect(computeTripReport(plan, "2026-10-09").status).toBe("upcoming");
  });

  it("首日 → ongoing（第 1 天）", () => {
    expect(computeTripReport(plan, "2026-10-10").status).toBe("ongoing");
  });

  it("末日 → ongoing（行程最后一天仍算进行中）", () => {
    expect(computeTripReport(plan, "2026-10-11").status).toBe("ongoing");
  });

  it("结束次日 → past（差一天就是已结束）", () => {
    expect(computeTripReport(plan, "2026-10-12").status).toBe("past");
  });

  it("远未来 → past", () => {
    expect(computeTripReport(plan, "2027-01-01").status).toBe("past");
  });

  it("不传 todayIso（SSR 首屏）→ unknown：不猜「今天」", () => {
    expect(computeTripReport(plan).status).toBe("unknown");
  });

  it("没有 startDate（旧数据/只填天数的请求）→ unknown", () => {
    const noDate = makePlan([{ spots: [spot("sight", 90, "测试景点")] }]);
    expect(computeTripReport(noDate, "2026-10-10").status).toBe("unknown");
  });

  it("startDate 非法（日历上不存在的日期）→ unknown", () => {
    const badDate = makePlan([{ spots: [spot("sight", 90, "测试景点")] }], {
      startDate: "2026-02-30",
      endDate: "2026-03-02",
    });
    expect(computeTripReport(badDate, "2026-03-01").status).toBe("unknown");
  });

  it("缺 endDate：按天数推算末日（与 tripToday 同一判定）", () => {
    const noEnd = fullPlan({ startDate: "2026-10-10" }); // 2 天 → 末日 10-11
    expect(computeTripReport(noEnd, "2026-10-09").status).toBe("upcoming");
    expect(computeTripReport(noEnd, "2026-10-10").status).toBe("ongoing");
    expect(computeTripReport(noEnd, "2026-10-11").status).toBe("ongoing");
    expect(computeTripReport(noEnd, "2026-10-12").status).toBe("past");
  });

  it("endDate 与天数推算不一致时：endDate 是用户声明的出行区间，优先于推算", () => {
    // 2 天行程但 endDate 声明只到 10-10：10-11 起算 past
    const weird = fullPlan({ startDate: "2026-10-10", endDate: "2026-10-10" });
    expect(computeTripReport(weird, "2026-10-10").status).toBe("ongoing");
    expect(computeTripReport(weird, "2026-10-11").status).toBe("past");
  });
});

// ---------- 脏数据防御（缺失/异常不炸、不猜） ----------

describe("computeTripReport：脏数据防御", () => {
  it("days 缺失/非数组：空统计，不抛错", () => {
    const broken = {
      city: "测试城",
      summary: "",
      totalCostCny: 0,
      tips: [],
      warnings: [],
      verified: false,
    } as unknown as Plan;
    const report = computeTripReport(broken);
    expect(report.spotCount).toBe(0);
    expect(report.totalCostCny).toBe(0);
    expect(report.days).toBe(0);
    expect(report.spots).toEqual([]);
  });

  it("空名字的条目不算站点；非法金额按 0 计", () => {
    const report = computeTripReport(
      makePlan([
        {
          spots: [
            spot("sight", 90, "有效景点"),
            spot("sight", 90, "   "), // 空名字：不算一站
            { ...spot("food", 35, "负花费餐厅"), costCny: -20 }, // 负数 → 0
            { ...spot("food", 35, "NaN 餐厅"), costCny: Number.NaN }, // 非数字 → 0
          ],
        },
      ]),
    );
    expect(report.spotCount).toBe(3);
    expect(report.totalCostCny).toBe(90);
  });

  it("非法 startDate 不回传：组件不渲染日期，也不编一个", () => {
    const report = computeTripReport(
      makePlan([{ spots: [spot("sight", 90, "测试景点")] }], { startDate: "10月10日" }),
    );
    expect(report.startDate).toBeUndefined();
  });
});
