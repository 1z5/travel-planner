import { describe, expect, it } from "vitest";
import { addDays, areaRegion, isRealDate, nameCovered } from "@/lib/validate";

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
