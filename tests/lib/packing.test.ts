import { describe, expect, it } from "vitest";
import { derivePackingList, PACKING_NO_WEATHER_NOTE } from "@/lib/packing";
import type { Plan, PlanDay, PlanSpot } from "@/lib/types";

// 出发前准备：钉住的契约是「只按真实依据推导、不塞通用清单」。
// 1. 有证据的规则都要出现，且每项带 reason + source；
// 2. 没有证据的项一律不出现（1 天室内行程 → 空清单）；
// 3. 不猜天气：函数不联网，降级说明由 UI 展示（常量导出）。

function spot(over: Partial<PlanSpot> = {}): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: "sight",
    name: "测试景点",
    area: "测试区",
    durationMin: 60,
    costCny: 50,
    reason: "单测",
    ...over,
  };
}

function day(dayNo: number, spots: PlanSpot[]): PlanDay {
  return { day: dayNo, theme: `第 ${dayNo} 天`, spots, transitMin: 0, dailyCostCny: 100 };
}

function plan(days: PlanDay[], tips: string[] = []): Plan {
  return {
    city: "苏州",
    summary: "测试行程",
    days,
    totalCostCny: 1000,
    tips,
    warnings: [],
    verified: true,
  };
}

describe("derivePackingList", () => {
  it("有雨天备选 = 室外景点 → 防晒与遮阳，来源引用当天与点位", () => {
    const p = plan([day(1, [spot({ name: "拙政园", rainBackup: "苏州博物馆（室内）" })])]);
    const items = derivePackingList(p);
    const sun = items.find((i) => i.label === "防晒与遮阳");
    expect(sun).toBeTruthy();
    expect(sun?.reason).toContain("室外");
    expect(sun?.source).toContain("第 1 天");
    expect(sun?.source).toContain("拙政园");
  });

  it("没有 rainBackup（未证明室外）→ 不推导防晒（不猜）", () => {
    const p = plan([day(1, [spot({ name: "苏州博物馆" })])]);
    expect(derivePackingList(p).some((i) => i.label === "防晒与遮阳")).toBe(false);
  });

  it("山地/湿地类点位 → 抓地运动鞋，来源引用点位", () => {
    const p = plan([day(2, [spot({ name: "天平山风景名胜区" })])]);
    const shoes = derivePackingList(p).find((i) => i.label === "抓地运动鞋");
    expect(shoes?.source).toContain("第 2 天");
    expect(shoes?.source).toContain("天平山");
  });

  it("有晚间行程 → 充电宝，来源标注晚间", () => {
    const p = plan([day(1, [spot({ name: "七里山塘", period: "evening" })])]);
    const power = derivePackingList(p).find((i) => i.label === "充电宝");
    expect(power?.source).toContain("晚间");
  });

  it("tips 提到预约/实名 → 身份证与预约凭证，来源引用提示原文", () => {
    const p = plan([day(1, [spot()])], ["苏州博物馆建议提前 7 天实名预约"]);
    const id = derivePackingList(p).find((i) => i.label === "身份证 + 预约凭证");
    expect(id).toBeTruthy();
    expect(id?.source).toContain("实名预约");
  });

  it("tips 没有预约词 → 不推导证件（不塞通用清单）", () => {
    const p = plan([day(1, [spot()])], ["带好雨具"]);
    expect(derivePackingList(p).some((i) => i.group === "document")).toBe(false);
  });

  it("行程 ≥3 天才推导常用药与换洗；2 天不推导", () => {
    const two = plan([day(1, [spot()]), day(2, [spot()])]);
    expect(derivePackingList(two).some((i) => i.group === "health")).toBe(false);

    const three = plan([day(1, [spot()]), day(2, [spot()]), day(3, [spot()])]);
    const health = derivePackingList(three).find((i) => i.group === "health");
    expect(health?.source).toContain("3 天");
  });

  it("1 天纯室内、无 tips → 空清单（绝不出现通用打包清单）", () => {
    const p = plan([day(1, [spot({ name: "苏州博物馆", type: "sight" })])], []);
    expect(derivePackingList(p)).toEqual([]);
  });

  it("推导顺序：证件 → 衣物 → 装备 → 健康；每项 reason/source 非空", () => {
    const p = plan(
      [
        day(1, [spot({ name: "拙政园", rainBackup: "苏州博物馆" })]),
        day(2, [spot({ name: "天平山", period: "evening" })]),
        day(3, [spot({ name: "同里古镇" })]),
      ],
      ["拙政园需要实名预约"],
    );
    const items = derivePackingList(p);
    expect(items.map((i) => i.group)).toEqual([
      "document",
      "clothing",
      "clothing",
      "gear",
      "health",
    ]);
    for (const it of items) {
      expect(it.reason.length).toBeGreaterThan(0);
      expect(it.source.length).toBeGreaterThan(0);
    }
  });

  it("天气未接入：降级文案是显式常量（UI 展示，不假装知道天气）", () => {
    expect(PACKING_NO_WEATHER_NOTE).toContain("天气");
    expect(PACKING_NO_WEATHER_NOTE).toContain("雨具");
  });
});
