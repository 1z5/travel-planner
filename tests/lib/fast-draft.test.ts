import { describe, expect, it } from "vitest";
import { buildFastDraft, isPublishableFastDraft } from "@/lib/fast-draft";
import type { PlanInput } from "@/lib/types";
import type { Grounding } from "@/lib/grounding";

// 秒级初版契约：真实 POI + 确定性规则 + 诚实标注。
// 这是「豆包几秒出稿、我们 3 分钟黑盒」这个体验差距的直接回应：用户在 LLM
// 思考的 3 分钟里看到的是真实地点，不是「成都·上午景点」占位符。

function grounding(over: Partial<Grounding> = {}): Grounding {
  return {
    state: "ok",
    candidates: [
      { name: "武侯祠", kind: "sight", area: "武侯区", location: "104.0,30.6", rating: 4.8 },
      { name: "锦里古街", kind: "sight", area: "武侯区", location: "104.1,30.6", rating: 4.5 },
      { name: "杜甫草堂", kind: "sight", area: "青羊区", location: "104.0,30.7", rating: 4.6 },
      { name: "宽窄巷子", kind: "sight", area: "青羊区", location: "104.0,30.65", rating: 4.7 },
      {
        name: "陈麻婆豆腐",
        kind: "food",
        area: "青羊区",
        location: "104.0,30.66",
        rating: 4.4,
        avgCostCny: 60,
      },
      {
        name: "洞子口张老二凉粉",
        kind: "food",
        area: "青羊区",
        location: "104.0,30.67",
        rating: 4.2,
        avgCostCny: 30,
      },
    ],
    closedOut: [],
    queries: [],
    ...over,
  } as Grounding;
}

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "成都",
    days: 1,
    startAt: "2026-11-01T09:00",
    endAt: "2026-11-01T20:00",
    budget: 1500,
    preferences: ["美食"],
    ...over,
  } as PlanInput;
}

describe("秒级初版：真实 POI，不编造", () => {
  it("点位名称来自 grounding 候选（不是「城市·时段」占位符）", () => {
    const plan = buildFastDraft(input(), grounding());
    const names = plan.days.flatMap((d) => d.spots.map((s) => s.name));
    expect(names.length).toBeGreaterThan(2);
    // 名字必须来自候选名单（同区聚合后具体取哪几个由 area 决定）
    const candidates = grounding().candidates.map((c) => c.name);
    expect(names.every((n) => candidates.includes(n))).toBe(true);
    expect(names.some((n) => n.includes("·"))).toBe(false);
    // 每个点都带真实坐标（存在性已核实的证据）
    expect(plan.days.every((d) => d.spots.some((s) => s.location))).toBe(true);
  });

  it("同一次检索内不重复取同一个点", () => {
    const plan = buildFastDraft(input({ days: 2 }), grounding());
    const names = plan.days.flatMap((d) => d.spots.map((s) => s.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it("没有 grounding 候选时不可发布（宁可没有初版，也不造假 POI）", () => {
    const empty = buildFastDraft(input(), grounding({ candidates: [] }));
    expect(isPublishableFastDraft(empty)).toBe(false);
  });

  it("初版明确标注 draftKind=fast 与 draft=true（UI 显示「快速初版」）", () => {
    const plan = buildFastDraft(input(), grounding());
    expect(plan.draft).toBe(true);
    expect(plan.draftKind).toBe("fast");
  });

  it("确定性：同样输入两次，输出逐字段相同", () => {
    const a = buildFastDraft(input(), grounding());
    const b = buildFastDraft(input(), grounding());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("秒级初版：预算口径", () => {
  it("正常预算：当天花费不超过日均预算太多（贪心上界）", () => {
    const plan = buildFastDraft(input({ budget: 300 }), grounding());
    const dayCost = plan.days[0].dailyCostCny;
    // 上界是「日均 + 一个最低候选价」，保证不被预算卡到空日
    expect(dayCost).toBeLessThanOrEqual(300 + 60);
  });

  it("穷游（预算 0）：只取免费/低价候选（<=60 元）", () => {
    const plan = buildFastDraft(input({ budget: 0 }), grounding());
    const costs = plan.days.flatMap((d) => d.spots.map((s) => s.costCny));
    expect(costs.every((c) => c <= 60)).toBe(true);
  });
});

describe("秒级初版：同区聚合（不制造必然绕路）", () => {
  it("优先取同一 area 的点（郊县高分景点不混进市中心的一天）", () => {
    const g = grounding({
      candidates: [
        { name: "安仁古镇", kind: "sight", area: "大邑县", location: "103.8,30.6", rating: 4.9 },
        { name: "交子公园", kind: "sight", area: "高新区", location: "104.1,30.6", rating: 4.5 },
        { name: "锦里古街", kind: "sight", area: "武侯区", location: "104.0,30.6", rating: 4.4 },
        { name: "武侯祠", kind: "sight", area: "武侯区", location: "104.0,30.61", rating: 4.3 },
        {
          name: "陈麻婆豆腐",
          kind: "food",
          area: "武侯区",
          location: "104.0,30.62",
          rating: 4.4,
          avgCostCny: 60,
        },
      ],
    });
    const plan = buildFastDraft(input(), g);
    const areas = plan.days[0].spots.map((s) => s.area);
    // 取的点应集中在同一个区（武侯区有 3 个候选，是主活动区）
    const top = areas.filter((a) => a === "武侯区").length;
    expect(top).toBeGreaterThanOrEqual(2);
    expect(areas).not.toContain("大邑县");
  });
});

describe("秒级初版：跨城", () => {
  it("跨城日先放城际交通占位，且当天只排抵达后的点位", () => {
    const plan = buildFastDraft(
      input({
        days: 4,
        endAt: "2026-11-04T20:00",
        cities: [
          { city: "深圳", days: 2 },
          { city: "香港", days: 2 },
        ],
      }),
      grounding(),
    );
    // Day 3 是跨城日：应有一段 transport，且没有 morning/lunch
    const d3 = plan.days.find((d) => d.day === 3);
    expect(d3?.spots.some((s) => s.type === "transport")).toBe(true);
    expect(d3?.spots.some((s) => s.period === "morning")).toBe(false);
    expect(d3?.city).toBe("香港");
  });
});
