import { describe, expect, it } from "vitest";
import { areaRegion } from "@/lib/validate";

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
