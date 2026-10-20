import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  areaRegion,
  isRealDate,
  nameCovered,
  refreshTimeWarnings,
  validateDay,
} from "@/lib/validate";
import { isHoursWarning, isScheduleWarning } from "@/lib/schedule";
import type { Plan, PlanDay, PlanInput, PlanLeg, PlanSpot } from "@/lib/types";

// 时间轴/营业时间体检要测 validateDay 的真实装配逻辑（legs → 冲突 → 文案），
// 但高德必须桩掉：只 mock 网络边界，被测算力/判定全部走真代码。
const amapStub = vi.hoisted(() => ({
  lookupPoi: vi.fn(),
  routeSegment: vi.fn(),
  transitMinutes: vi.fn(),
}));

vi.mock("@/lib/amap", () => ({
  // 关键：走「真实模式」分支，才会回填坐标、算 legs、跑营业时间体检
  AMAP_MOCK: false,
  lookupPoi: amapStub.lookupPoi,
  routeSegment: amapStub.routeSegment,
  transitMinutes: amapStub.transitMinutes,
}));

// areaRegion 是区域分散度预警的地基：归一化错一格，预警就会误报或漏报
// （误合并 → 漏报分散；误拆分 → 把正常行程报成散沙）。它的行为必须钉死。

describe("areaRegion 归一化", () => {
  it("真实样本：2-3 字区县 + 商圈后缀 → 归到区县", () => {
    // 来自京都 5 天真机冒烟的真实 area 字符串
    expect(areaRegion("北区金阁寺")).toBe("北区");
    expect(areaRegion("东山区清水")).toBe("东山区");
    expect(areaRegion("右京区岚山")).toBe("右京区");
    expect(areaRegion("伏见区深草")).toBe("伏见区");
    expect(areaRegion("中京区二条城")).toBe("中京区");
    expect(areaRegion("上京区京都御苑（二条城东侧）")).toBe("上京区");
    expect(areaRegion("下京区京都站")).toBe("下京区");
  });

  it("核心性质：同一区县的不同商圈字符串必须归并为一", () => {
    // 这是归一化存在的全部理由——「祇园」「先斗町」实为同一带。
    // 只放带区县前缀的字符串：无前缀的（如「祇园至鸭川先斗町」这种移动段
    // 描述）无法归属，会原样返回，见下一条「已知局限」。
    const variants = [
      "东山区祇园",
      "东山区东山古道",
      "东山区清水",
      "东山区円山",
    ];
    const regions = new Set(variants.map(areaRegion));
    expect(regions.size).toBe(1);
    expect([...regions][0]).toBe("东山区");
  });

  it("已知局限：无区县前缀的商圈名无法归属，会各算一个区域", () => {
    // 归一化的固有权衡：宁可把「春熙路」「祇园」各算一区（可能多报），
    // 也不能猜一个区县硬并进去（会把不同区域误合并，导致漏报）。
    // 实践中影响有限——预警只统计 sight 类型的点，真实数据里景点的
    // area 大多带区县前缀；移动段（「X至Y」）不参与计数。
    const regions = new Set(["祇园", "先斗町", "春熙路"].map(areaRegion));
    expect(regions.size).toBe(3);
  });

  it("不同区县必须保持独立（不能为减少预警把不同区并成一个）", () => {
    const regions = new Set(
      ["北区金阁寺", "东山区清水", "右京区岚山", "伏见区深草"].map(areaRegion),
    );
    expect(regions.size).toBe(4);
  });

  it("4 字区县也能正确切分（浦东新区 → 浦东新区，不是浦东）", () => {
    expect(areaRegion("浦东新区陆家嘴")).toBe("浦东新区");
    expect(areaRegion("浦东新区")).toBe("浦东新区");
  });

  it("无区县前缀的原样返回，不与其他地方合并", () => {
    expect(areaRegion("春熙路")).toBe("春熙路");
    expect(areaRegion("东福寺一带")).toBe("东福寺一带");
    expect(areaRegion("四条河原町")).toBe("四条河原町");
    expect(areaRegion("祇园")).toBe("祇园");
    expect(areaRegion("先斗町")).toBe("先斗町");
  });

  it("边界输入不抛错、不产生 undefined", () => {
    expect(areaRegion("")).toBe("");
    expect(areaRegion("区")).toBe("区");
    expect(areaRegion("区区")).toBe("区区");
    // 非字符串输入（模型偶尔会给数字/null）也不能崩
    expect(areaRegion(String(123))).toBe("123");
    expect(areaRegion(String(null))).toBe("null");
  });

  it("县/市/镇/乡 前缀同样支持", () => {
    expect(areaRegion("大理市古城")).toBe("大理市");
    expect(areaRegion("婺源县江湾")).toBe("婺源县");
    expect(areaRegion("乌镇")).toBe("乌镇"); // 镇在后面，不在开头，不切
  });
});

// nameCovered 的边界值（真机踩坑后补的回归）：
// 用户写简称、模型落成场馆全称是**正确执行**，不能误报漏排；
// 但 genuinely 没排的也不能被最长公共子串误放过。
describe("nameCovered 名称匹配", () => {
  const FIXTURE_SPOTS = [
    "拙政园", "姑苏桥·文人苏式面馆", "苏州博物馆", "平江历史街区",
    "桃花源记", "七里山塘", "苏州书香府邸·平江府", "天平山风景名胜区",
    "石家饭店", "木渎古镇", "协和菜馆", "十全街", "同里古镇",
    "同里状元居", "同里国家湿地公园", "老苏州茶酒楼",
  ];

  it("完整包含：用户写了确切名称", () => {
    expect(nameCovered("拙政园", FIXTURE_SPOTS)).toBe(true);
  });

  it("双向包含：模型用了更短的规范名", () => {
    expect(nameCovered("苏州博物馆", ["苏州博物馆"])).toBe(true);
    expect(nameCovered("拙政园与狮子林", ["拙政园"])).toBe(true);
  });

  it("别名/简称：最长公共子串 ≥3 即算覆盖", () => {
    // 真机 case：用户写简称，模型落成场馆全称
    expect(nameCovered("成都川剧变脸演出", ["蜀风雅韵川剧变脸演出(琴台路店)"])).toBe(true);
    expect(nameCovered("成都大熊猫基地", ["成都大熊猫繁育研究基地"])).toBe(true);
    expect(nameCovered("武侯祠", ["成都武侯祠博物馆"])).toBe(true);
  });

  it("不相关的名字不能被子串误放过", () => {
    expect(nameCovered("测试必游地X", FIXTURE_SPOTS)).toBe(false);
    expect(nameCovered("不存在的演出", FIXTURE_SPOTS)).toBe(false);
    expect(nameCovered("周杰伦演唱会", FIXTURE_SPOTS)).toBe(false);
  });

  it("公共子串只有 1-2 字时不算覆盖（防止误放过）", () => {
    // 「园」字相同但完全不是一回事
    expect(nameCovered("中华恐龙园", FIXTURE_SPOTS)).toBe(false);
    // 「古镇」2 字相同，仍不足 3 字阈值
    expect(nameCovered("丽江古城", FIXTURE_SPOTS)).toBe(false);
  });

  it("空名与空候选的安全处理", () => {
    expect(nameCovered("", FIXTURE_SPOTS)).toBe(false);
    expect(nameCovered("  ", FIXTURE_SPOTS)).toBe(false);
    expect(nameCovered("拙政园", [])).toBe(false);
  });
});

// isRealDate 是活动日期校验的地基：API 的 DT_RE 只查格式，"2026-02-30T09:00"
// 能过 schema。拿这种值做日期运算会抛 RangeError，而 finalizePlan 没有
// try/catch 兜底——这个 guard 漏了就是把崩溃路径引进主流程。
describe("isRealDate 日历合法性", () => {
  it("正常日期通过", () => {
    expect(isRealDate("2026-10-18")).toBe(true);
    expect(isRealDate("2024-02-29")).toBe(true); // 闰年
    expect(isRealDate("2026-01-01")).toBe(true);
  });

  it("格式对但日历非法的日期必须判 false（round-trip 对不上）", () => {
    // new Date("2026-02-30") 会静默规范成 3 月 2 日——这正是要挡的
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-04-31")).toBe(false);
    expect(isRealDate("2026-00-10")).toBe(false);
  });

  it("平年 2 月 29 日非法（闰年规则）", () => {
    expect(isRealDate("2026-02-29")).toBe(false); // 2026 不是闰年
    expect(isRealDate("2024-02-29")).toBe(true);  // 2024 是闰年
  });

  it("格式不符直接 false（不抛错）", () => {
    expect(isRealDate("10月18日")).toBe(false);
    expect(isRealDate("2026-1-1")).toBe(false);
    expect(isRealDate("")).toBe(false);
  });
});

describe("addDays 日期算术", () => {
  it("常规递增", () => {
    expect(addDays("2026-10-18", 0)).toBe("2026-10-18");
    expect(addDays("2026-10-18", 1)).toBe("2026-10-19");
    expect(addDays("2026-10-18", 3)).toBe("2026-10-21");
  });

  it("跨月/跨年正确滚动", () => {
    expect(addDays("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // 闰年
  });

  it("用 UTC 算术，不受运行时本地时区影响", () => {
    // 若用本地时间构造，在 UTC+X 时区可能算出前一天
    expect(addDays("2026-01-01", 1)).toBe("2026-01-02");
  });
});

// ============================================================
// 可执行性（本轮新增）：时间轴冲突体检 + 预警刷新
//
// 体检链路（POI 验真 → 通勤/legs → 时间轴判定 → 文案）必须走真实代码，
// 只桩掉高德网络边界。这里钉住三件事：
// 1) 每天最多 1 条汇总预警，且含前端识别用的稳定标记词；
// 2) legs 接得上/没有 legs 时不能误报；
// 3) refreshTimeWarnings 只替换「时间轴 + 营业时间」两类，其它警告顺序不变。
// ============================================================

function mkSpot(over: Partial<PlanSpot> & { name: string }): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: "sight",
    area: "姑苏区",
    durationMin: 60,
    costCny: 50,
    reason: "测试用行程点",
    ...over,
  };
}

function mkLeg(from: string, to: string, durationSec = 1320): PlanLeg {
  return { from, to, mode: "driving", distanceM: 5000, durationSec, steps: ["直行"] };
}

function mkDay(spots: PlanSpot[], legs?: PlanLeg[], day = 1): PlanDay {
  return {
    day,
    theme: "测试日",
    spots,
    transitMin: 0,
    dailyCostCny: 0,
    ...(legs ? { legs } : {}),
  };
}

function mkPlan(day: PlanDay | PlanDay[], over: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    startDate: "2026-10-10",
    summary: "测试行程",
    days: Array.isArray(day) ? day : [day],
    totalCostCny: 0,
    tips: [],
    warnings: [],
    verified: true,
    ...over,
  };
}

function mkInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "苏州",
    days: 1,
    startAt: "2026-10-10T08:00",
    endAt: "2026-10-10T18:00",
    budget: 1000,
    preferences: [],
    transportMode: "driving",
    events: [],
    ...over,
  };
}

beforeEach(() => {
  // 默认桩：每个 POI 命中且带坐标；每段路 22 分钟（1320 秒）；通勤 22 分钟
  amapStub.lookupPoi.mockReset();
  amapStub.lookupPoi.mockImplementation(async (_city: string, name: string) => ({
    state: "hit",
    poi: {
      name,
      address: "测试地址",
      location: "120.620000,31.320000",
      adname: "姑苏区",
      verified: true,
    },
  }));
  amapStub.routeSegment.mockReset();
  amapStub.routeSegment.mockImplementation(async () => ({
    state: "ok",
    leg: { distanceM: 5000, durationSec: 1320, steps: ["直行"] },
  }));
  amapStub.transitMinutes.mockReset();
  amapStub.transitMinutes.mockImplementation(async () => ({ state: "ok", minutes: 22 }));
});

describe("时间轴冲突体检（validateDay 真实装配）", () => {
  it("每天汇总成 1 条：含「时间接不上」「一键顺延」与首段冲突细节", async () => {
    const day = mkDay([
      mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
      mkSpot({ name: "面馆", type: "food", period: "lunch", time: "10:15-11:15" }),
      mkSpot({ name: "博物馆", time: "11:30-12:30" }),
    ]);
    const plan = mkPlan(day);
    const check = await validateDay(plan, day, mkInput());

    const schedules = check.warnings.filter(isScheduleWarning);
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toContain("第 1 天有 2 段「时间接不上」");
    // K>1 给首段示例：谁、几点结束、到谁、几点开始、差多少、路要多久
    expect(schedules[0]).toContain(
      "如「拙政园」10:00 结束到「面馆」10:15 开始只有 15 分钟，但驾车约需 22 分钟",
    );
    expect(schedules[0]).toContain("可用「一键顺延」重排当天时间轴");
    // 顺延入口是确定性重排，不是模型：文案必须引导到「一键顺延」
    expect(schedules[0]).not.toContain("重排这一天");
  });

  it("K=1 时不给「如」示例（避免冗余表述）", async () => {
    const day = mkDay([
      mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
      mkSpot({ name: "B", time: "10:15-11:15" }),
    ]);
    const check = await validateDay(mkPlan(day), day, mkInput());
    const [w] = check.warnings.filter(isScheduleWarning);
    expect(w).toContain("第 1 天有 1 段「时间接不上」：「A」10:00 结束到「B」10:15 开始只有 15 分钟");
    expect(w).not.toContain("如「");
  });

  it("legs 接得上（间距 ≥ 真实耗时）不报时间轴", async () => {
    const day = mkDay([
      mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
      mkSpot({ name: "B", time: "10:30-11:30" }), // 间距 30 > 22
    ]);
    const check = await validateDay(mkPlan(day), day, mkInput());
    expect(check.warnings.filter(isScheduleWarning)).toHaveLength(0);
  });

  it("时间重叠单独措辞（不写成「只有 -10 分钟」）", async () => {
    const day = mkDay([
      mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
      mkSpot({ name: "B", time: "09:50-11:00" }),
    ]);
    const check = await validateDay(mkPlan(day), day, mkInput());
    const [w] = check.warnings.filter(isScheduleWarning);
    expect(w).toContain("两段时间重叠 10 分钟");
    expect(w).not.toContain("只有 -");
  });

  it("没有 legs（未验真/旧行程/MOCK）不报——没有依据就不下结论", async () => {
    amapStub.routeSegment.mockResolvedValue({ state: "error", reason: "桩：路线失败" });
    const day = mkDay([
      mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
      mkSpot({ name: "B", time: "10:15-11:15" }),
    ]);
    const check = await validateDay(mkPlan(day), day, mkInput());
    expect(day.legs).toBeUndefined();
    expect(check.warnings.filter(isScheduleWarning)).toHaveLength(0);
  });
});

describe("refreshTimeWarnings 只刷新时间轴/营业两类", () => {
  function conflictPlan(warnings: string[]): Plan {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "B", time: "10:15-11:15" }),
      ],
      [mkLeg("A", "B")],
    );
    return mkPlan(day, { warnings });
  }

  it("替换旧的时间轴预警、保留其它预警且顺序不变", () => {
    const plan = conflictPlan([
      "第 1 天安排约 4 小时，偏松，可加一个景点或放慢节奏",
      "第 1 天有 5 段「时间接不上」：旧文案",
      "预算较为宽松：合计人均约 800 元",
      "第 2 天「旧馆」周一闭馆（高德：周一 全天不开放），当天去不了",
    ]);
    const out = refreshTimeWarnings(plan, mkInput());
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("偏松");
    expect(isScheduleWarning(out[1])).toBe(true);
    expect(out[1]).toContain("第 1 天有 1 段「时间接不上」");
    expect(out[2]).toContain("预算较为宽松");
    // 旧的营业类预警被清掉（重算了：这份 plan 没有 poi 数据 → 不产生新营业预警）
    expect(out.some((w) => w.includes("旧馆"))).toBe(false);
  });

  it("重排后冲突已消失：旧时间轴预警被删除，不产生新预警", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "B", time: "10:22-11:22" }),
      ],
      [mkLeg("A", "B")],
    );
    const plan = mkPlan(day, {
      warnings: ["第 1 天有 1 段「时间接不上」：旧文案", "行程合计人均约 3000 元"],
    });
    const out = refreshTimeWarnings(plan, mkInput());
    expect(out).toEqual(["行程合计人均约 3000 元"]);
  });

  it("原警告里没有时间类：新结论追加在末尾，其它顺序不变", () => {
    const plan = conflictPlan(["预警甲", "预警乙"]);
    const out = refreshTimeWarnings(plan, mkInput());
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2)).toEqual(["预警甲", "预警乙"]);
    expect(isScheduleWarning(out[2])).toBe(true);
  });

  it("幂等：对刷新结果再刷新一次，预警逐条相同（不会重复 append）", () => {
    const plan = conflictPlan([
      "第 1 天有 1 段「时间接不上」：旧文案",
      "预算较为宽松：合计人均约 800 元",
    ]);
    const once = refreshTimeWarnings(plan, mkInput());
    const twice = refreshTimeWarnings({ ...plan, warnings: once }, mkInput());
    expect(twice).toEqual(once);
  });
});

// ============================================================
// 营业时间体检（本轮新增）：闭馆日 / 没开门 / 暂停开放
//
// 关键约定：
// - 只对「有 spot.poi 且高德给了营业时间原文」的地点判定；unknown/无日期一律
//   不告警（宁可漏报不误报）；
// - 三类文案的标记词必须稳定（warn-tag 的「营业」标签、fix-actions 的 hours
//   识别、Lead 的 e2e 都按它们匹配）：闭馆含「闭馆」；outside 用「才开门」或
//   「营业时间」；暂停开放含「暂停开放」；outside 不能出现「时间接不上」。
// ============================================================

describe("营业时间体检", () => {
  // 2026-10-10 是周六：第 1 天=周六、第 3 天=周一（2026-10-12，已用 UTC 校验）
  const MUSEUM_POI = { openTime2: "周二至周日 09:00-17:00；周一 全天不开放" };

  it("closed：周一去闭馆的博物馆 → 1 条，含「闭馆」「当天去不了」", () => {
    const day3 = mkDay(
      [mkSpot({ name: "苏州博物馆", time: "09:00-10:00", poi: MUSEUM_POI })],
      undefined,
      3,
    );
    const out = refreshTimeWarnings(mkPlan(day3), mkInput());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("第 3 天「苏州博物馆」");
    // 「周一 全天不开放」统一成「周一闭馆」口径（用户熟悉 + 稳定标记词）
    expect(out[0]).toContain("周一闭馆");
    expect(out[0]).toContain("当天去不了");
    expect(out[0]).toContain("高德：");
    expect(out[0]).not.toContain("时间接不上");
  });

  it("open：营业时间内到达/离开 → 不告警", () => {
    const day1 = mkDay([mkSpot({ name: "苏州博物馆", time: "09:00-10:00", poi: MUSEUM_POI })]);
    expect(refreshTimeWarnings(mkPlan(day1), mkInput())).toEqual([]);
  });

  it("unknown：营业时间原文解析不出 → 不告警（不猜）", () => {
    const day1 = mkDay([
      mkSpot({
        name: "某小馆",
        time: "09:00-10:00",
        poi: { openTime2: "季节性开放，详情请咨询景区" },
      }),
    ]);
    expect(refreshTimeWarnings(mkPlan(day1), mkInput())).toEqual([]);
  });

  it("无 startDate → 算不出周几，一律不告警", () => {
    const day3 = mkDay(
      [mkSpot({ name: "苏州博物馆", time: "09:00-10:00", poi: MUSEUM_POI })],
      undefined,
      3,
    );
    const plan = mkPlan(day3, { startDate: undefined });
    expect(refreshTimeWarnings(plan, mkInput())).toEqual([]);
  });

  it("outside：08:00 到但 09:00 才开门 → 含「才开门」「营业时间」+「一键顺延」", () => {
    const day1 = mkDay([
      mkSpot({
        name: "拙政园",
        time: "08:00-10:00",
        poi: { openTime2: "周一至周日 09:00-17:00" },
      }),
    ]);
    const out = refreshTimeWarnings(mkPlan(day1), mkInput());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("第 1 天「拙政园」计划 08:00-10:00");
    expect(out[0]).toContain("才开门");
    expect(out[0]).toContain("营业时间对不上");
    expect(out[0]).toContain("可能进不去");
    expect(out[0]).toContain("建议用「一键顺延」调整时间");
    // 时间轴冲突是另一类（会路由到 adjust retime），outside 不能带那个标记
    expect(out[0]).not.toContain("时间接不上");
  });

  it("outside：关门早于安排结束 → 同样给「一键顺延」提示（文案含营业时间）", () => {
    const day1 = mkDay([
      mkSpot({
        name: "拙政园",
        time: "16:00-18:00",
        durationMin: 120,
        poi: { openTime2: "周一至周日 09:00-17:00" },
      }),
    ]);
    const [w] = refreshTimeWarnings(mkPlan(day1), mkInput());
    expect(w).toContain("关门");
    expect(w).toContain("营业时间对不上");
    expect(w).toContain("一键顺延");
  });

  it("temporarilyClosed：高德标记暂停开放 → 1 条含「暂停开放」「出发前请确认」", () => {
    const day1 = mkDay([
      mkSpot({
        name: "金沙遗址博物馆",
        time: "09:00-10:00",
        poi: { temporarilyClosed: true },
      }),
    ]);
    const out = refreshTimeWarnings(mkPlan(day1), mkInput());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("第 1 天「金沙遗址博物馆」");
    expect(out[0]).toContain("暂停开放");
    expect(out[0]).toContain("出发前请确认");
  });

  it("每天最多 2 条，且「暂停开放/闭馆」优先于「时间对不上」", () => {
    const day1 = mkDay([
      mkSpot({ name: "A馆", time: "08:00-10:00", poi: { openTime2: "周一至周日 09:00-17:00" } }),
      mkSpot({ name: "B馆", time: "08:00-10:00", poi: { openTime2: "周一至周日 09:00-17:00" } }),
      mkSpot({ name: "C馆", time: "10:00-11:00", poi: { temporarilyClosed: true } }),
    ]);
    const out = refreshTimeWarnings(mkPlan(day1), mkInput());
    expect(out).toHaveLength(2);
    // 暂停开放排最前（当天去不了的硬伤先于「可能进不去」）
    expect(out[0]).toContain("暂停开放");
    expect(out[1]).toContain("才开门");
  });

  it("没有 spot.poi（MOCK/未验真/旧行程）→ 不告警", () => {
    const day1 = mkDay([mkSpot({ name: "拙政园", time: "08:00-10:00" })]);
    expect(refreshTimeWarnings(mkPlan(day1), mkInput())).toEqual([]);
  });

  it("refresh：旧营业类预警被替换、其它预警顺序不变", () => {
    const day3 = mkDay(
      [mkSpot({ name: "苏州博物馆", time: "09:00-10:00", poi: MUSEUM_POI })],
      undefined,
      3,
    );
    const plan = mkPlan(day3, {
      warnings: [
        "第 1 天安排约 7 小时，偏松，可加一个景点或放慢节奏",
        "第 3 天「旧馆」周一闭馆（高德：旧文案），当天去不了",
        "行程合计人均约 3000 元",
      ],
    });
    const out = refreshTimeWarnings(plan, mkInput());
    expect(out).toHaveLength(3);
    expect(out[0]).toContain("偏松");
    expect(out[1]).toContain("第 3 天「苏州博物馆」");
    expect(out[1]).toContain("闭馆");
    expect(out[2]).toContain("行程合计人均约 3000 元");
    expect(out.some((w) => w.includes("旧馆"))).toBe(false);
  });
});

describe("POI 详情回填（validateDay）", () => {
  it("验真命中时写入 spot.poi（评分/人均/营业时间/暂停标记），供体检与前端用", async () => {
    amapStub.lookupPoi.mockImplementation(async (_city: string, name: string) => ({
      state: "hit",
      poi: {
        name,
        address: "测试地址",
        location: "120.620000,31.320000",
        adname: "姑苏区",
        verified: true,
        rating: 4.8,
        avgCostCny: 65,
        openTime: "09:00-17:00",
        openTime2: "周一至周日 09:00-17:00",
        tel: "0512-00000000",
        temporarilyClosed: true,
      },
    }));
    const day = mkDay([mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 })]);
    const plan = mkPlan(day);
    const check = await validateDay(plan, day, mkInput());
    expect(day.spots[0].poi).toEqual({
      rating: 4.8,
      avgCostCny: 65,
      openTime: "09:00-17:00",
      openTime2: "周一至周日 09:00-17:00",
      tel: "0512-00000000",
      temporarilyClosed: true,
    });
    // 暂停开放 + 08:00 早于开门：暂停开放这条进预警（最高优先级）
    expect(check.warnings.some((w) => w.includes("暂停开放"))).toBe(true);
  });

  it("高德没给任何详情 → 不建 poi 对象（缺字段=没数据，不是默认值）", async () => {
    const day = mkDay([mkSpot({ name: "拙政园", time: "09:00-10:00" })]);
    const plan = mkPlan(day);
    await validateDay(plan, day, mkInput());
    expect(day.spots[0].poi).toBeUndefined();
  });
});
