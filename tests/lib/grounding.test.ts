import { describe, expect, it } from "vitest";
import {
  classifyPoi,
  collectGrounding,
  groundingSummary,
  groundingSummaryOf,
  renderGroundingPrompt,
  tripDates,
  type Grounding,
  type PoiSearcher,
} from "@/lib/grounding";
import type { PlanInput } from "@/lib/types";

// 事实先行（grounding）的单测。
//
// 核心不变式：
// 1. **拿不到事实就不编**——全部检索失败/无覆盖时 state=unavailable，候选为空；
// 2. **闭馆只对确信的日子生效**——周一闭馆的博物馆在周二照常可用；
// 3. **全程闭馆才剔除**，部分闭馆只是标注出来提示模型换天；
// 4. **降级不阻断**——检索抛异常也只影响事实层，不影响主流程。

const baseInput: PlanInput = {
  city: "苏州",
  days: 3,
  budget: 3000,
  preferences: ["人文"],
  startAt: "2026-10-19T09:00", // 周一
  endAt: "2026-10-21T20:00",
};

/** 一条高德 POI 的原始返回形状（grounding 内部用它做归类与事实提取） */
interface PoiSpec {
  name: string;
  type?: string;
  adname?: string;
  location?: string;
  openTime?: string;
  openTime2?: string;
  rating?: string;
  cost?: string;
}

function poi(o: PoiSpec) {
  return mkPoi(o);
}

function mkPoi(o: PoiSpec): {
  name: string;
  address: string;
  location: string;
  adname: string;
  verified: boolean;
  poiType?: string;
  rating?: number;
  avgCostCny?: number;
  openTime?: string;
  openTime2?: string;
} {
  const out: ReturnType<typeof mkPoi> = {
    name: o.name,
    address: `${o.name} 地址`,
    location: o.location ?? "120.620000,31.320000",
    adname: o.adname ?? "姑苏区",
    verified: true,
  };
  if (o.type) out.poiType = o.type;
  if (o.rating) out.rating = Number(o.rating);
  if (o.cost) out.avgCostCny = Number(o.cost);
  if (o.openTime) out.openTime = o.openTime;
  if (o.openTime2) out.openTime2 = o.openTime2;
  return out;
}

function searcherFrom(poisByKeyword: Record<string, ReturnType<typeof mkPoi>[]>): PoiSearcher {
  return async ({ keywords }) => {
    const hit = poisByKeyword[keywords];
    if (!hit) return { state: "miss" };
    return { state: "hit", pois: hit };
  };
}

describe("classifyPoi：只按高德自己的 type 归类", () => {
  it("景点 / 餐饮 按分类名识别", () => {
    expect(classifyPoi("风景名胜|公园广场")).toBe("sight");
    expect(classifyPoi("科教文化服务|博物馆")).toBe("sight");
    expect(classifyPoi("风景名胜|古镇")).toBe("sight");
    expect(classifyPoi("餐饮服务|中餐厅")).toBe("food");
    expect(classifyPoi("餐饮服务|小吃快餐")).toBe("food");
  });

  it("购物/住宿/交通等不是行程主体，归为 null（丢弃）", () => {
    expect(classifyPoi("购物服务|服装购物")).toBeNull();
    expect(classifyPoi("住宿服务|宾馆酒店")).toBeNull();
    expect(classifyPoi("汽车服务|汽车租赁")).toBeNull();
    expect(classifyPoi(undefined)).toBeNull();
  });
});

describe("tripDates：从起止时间推出行程日期", () => {
  it("按天展开", () => {
    expect(tripDates(baseInput)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21"]);
  });

  it("没有起止时间就不知道日期（不猜）", () => {
    expect(tripDates({ ...baseInput, startAt: undefined })).toEqual([]);
  });
});

describe("collectGrounding：事实清单的三态与降级", () => {
  it("检索命中 → 候选带真实事实字段", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "拙政园",
            type: "风景名胜|公园广场",
            openTime2: "08:00-17:30",
            rating: "4.8",
          }),
        ],
        "苏州 餐厅": [
          poi({
            name: "同得兴",
            type: "餐饮服务|面馆",
            openTime2: "07:00-19:30",
            cost: "35",
            location: "120.610000,31.310000",
          }),
        ],
      }),
    });

    expect(g.state).toBe("ok");
    expect(g.candidates.map((c) => c.name)).toContain("拙政园");
    const sight = g.candidates.find((c) => c.name === "拙政园")!;
    expect(sight.kind).toBe("sight");
    expect(sight.rating).toBe(4.8);
    expect(sight.hours).toBe("08:00-17:30");
    const food = g.candidates.find((c) => c.name === "同得兴")!;
    expect(food.kind).toBe("food");
    expect(food.avgCostCny).toBe(35);
  });

  it("全部检索失败 → unavailable（不编候选），并给出可读的降级说明", async () => {
    const g = await collectGrounding(baseInput, {
      search: async () => ({ state: "error", reason: "10021 QPS 超限" }),
    });
    expect(g.state).toBe("unavailable");
    expect(g.candidates).toHaveLength(0);
    expect(g.note).toContain("高德");
  });

  it("检索抛异常也不炸（降级不阻断）", async () => {
    const g = await collectGrounding(baseInput, {
      search: async () => {
        throw new Error("网络异常");
      },
    });
    expect(g.state).toBe("unavailable");
    expect(g.candidates).toHaveLength(0);
  });

  it("检索到但都不是景点/餐饮 → empty", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [poi({ name: "某某酒店", type: "住宿服务|宾馆酒店" })],
      }),
    });
    expect(g.state).toBe("empty");
    expect(g.candidates).toHaveLength(0);
  });

  it("同名同位置只保留一条（多组关键词会检索到同一个点）", async () => {
    const dup = poi({ name: "拙政园", type: "风景名胜|公园广场" });
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [dup],
        "苏州 博物馆": [{ ...dup }],
      }),
    });
    expect(g.candidates.filter((c) => c.name === "拙政园")).toHaveLength(1);
  });

  it("同一地点在不同关键词下重复出现时保留事实更全的那条", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [poi({ name: "拙政园", type: "风景名胜|公园广场" })],
        "苏州 古镇": [
          poi({
            name: "拙政园",
            type: "风景名胜|公园广场",
            rating: "4.8",
            openTime2: "08:00-17:30",
          }),
        ],
      }),
    });
    const c = g.candidates.find((x) => x.name === "拙政园")!;
    expect(c.rating).toBe(4.8);
    expect(c.hours).toBe("08:00-17:30");
  });
});

describe("collectGrounding：闭馆日的三种处理", () => {
  it("部分日期闭馆 → 保留候选并标注闭馆日（模型可以换到开门的日子）", async () => {
    // 周一闭馆；行程 10-19(周一) ~ 10-21(周三)
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "苏州博物馆",
            type: "科教文化服务|博物馆",
            openTime2: "周二至周日 09:00-17:00；周一 全天不开放",
          }),
        ],
      }),
    });
    const c = g.candidates.find((x) => x.name === "苏州博物馆")!;
    expect(c).toBeDefined();
    expect(c.closedOn).toContain("10-19");
    expect(c.closedReason).toContain("周一");
    // 只有 1 天闭馆，其余两天照常可用 → 不能整条剔除
    expect(g.closedOut.map((x) => x.name)).not.toContain("苏州博物馆");
  });

  it("全程闭馆 → 从候选剔除，并进「不要安排」清单", async () => {
    // 整段行程期临时闭馆（真实公告形态：带日期段的闭馆）
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "闭馆景点",
            type: "风景名胜|公园广场",
            openTime2: "09:00-17:00；10/19-10/21 全天不开放",
          }),
        ],
      }),
    });
    expect(g.candidates.map((c) => c.name)).not.toContain("闭馆景点");
    expect(g.closedOut.map((c) => c.name)).toContain("闭馆景点");
  });

  it("暂停开放（高德用名称表达）→ 视为全程闭馆", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "金沙遗址博物馆(暂停开放)",
            type: "风景名胜|公园广场",
            openTime2: "09:00-17:00",
          }),
        ],
      }),
    });
    expect(g.candidates.map((c) => c.name)).not.toContain("金沙遗址博物馆(暂停开放)");
    expect(g.closedOut.map((c) => c.name)).toContain("金沙遗址博物馆(暂停开放)");
  });

  it("营业时间读不懂 → 照常进候选但不标时间（宁可少说，不能说错）", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "神秘景点",
            type: "风景名胜|公园广场",
            openTime2: "具体营业时间请咨询景区",
          }),
        ],
      }),
    });
    const c = g.candidates.find((x) => x.name === "神秘景点")!;
    expect(c).toBeDefined();
    expect(c.hours).toBeUndefined();
    expect(c.closedOn).toBeUndefined();
  });
});

describe("renderGroundingPrompt：清单怎么进 prompt", () => {
  it("ok 状态 → 输出清单 + 闭馆禁令", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({
            name: "拙政园",
            type: "风景名胜|公园广场",
            openTime2: "08:00-17:30",
            rating: "4.8",
          }),
          poi({
            name: "闭馆景点",
            type: "风景名胜|公园广场",
            openTime2: "09:00-17:00；10/19-10/21 全天不开放",
          }),
        ],
        "苏州 餐厅": [
          poi({
            name: "同得兴",
            type: "餐饮服务|面馆",
            openTime2: "07:00-19:30",
            cost: "35",
            location: "120.610000,31.310000",
          }),
        ],
      }),
    });
    const text = renderGroundingPrompt(g);
    expect(text).toContain("真实素材清单");
    expect(text).toContain("拙政园");
    expect(text).toContain("同得兴");
    expect(text).toContain("评分 4.8");
    expect(text).toContain("人均约 35 元");
    expect(text).toContain("全程闭馆，不要安排");
    expect(text).toContain("闭馆景点");
  });

  it("没有清单时输出空串（prompt 与改动前完全一致）", () => {
    expect(
      renderGroundingPrompt({ state: "unavailable", candidates: [], closedOut: [], queries: [] }),
    ).toBe("");
    expect(
      renderGroundingPrompt({ state: "empty", candidates: [], closedOut: [], queries: [] }),
    ).toBe("");
  });
});

describe("摘要：如实告诉用户清单有多大", () => {
  it("ok → 候选数 / 闭馆提示数 / 剔除数", async () => {
    const g = await collectGrounding(baseInput, {
      search: searcherFrom({
        "苏州 景点": [
          poi({ name: "拙政园", type: "风景名胜|公园广场", openTime2: "08:00-17:30" }),
          poi({
            name: "苏州博物馆",
            type: "科教文化服务|博物馆",
            openTime2: "周二至周日 09:00-17:00；周一 全天不开放",
          }),
          poi({
            name: "闭馆景点",
            type: "风景名胜|公园广场",
            openTime2: "09:00-17:00；10/19-10/21 全天不开放",
          }),
        ],
      }),
    });
    const s = groundingSummary(g)!;
    expect(s.candidates).toBe(2);
    expect(s.closedSkipped).toBe(1);
    expect(s.closedOut).toBe(1);
  });

  it("没有事实层 → undefined（UI 要能区分「没用」与「很少」）", () => {
    expect(groundingSummary(undefined)).toBeUndefined();
    expect(
      groundingSummary({ state: "unavailable", candidates: [], closedOut: [], queries: [] }),
    ).toBeUndefined();
  });

  it("多份清单取并集去重", () => {
    const c: Grounding["candidates"][number] = {
      name: "拙政园",
      kind: "sight",
      area: "姑苏区",
      location: "120.62,31.32",
    };
    const g1: Grounding = { state: "ok", candidates: [c], closedOut: [], queries: [] };
    const g2: Grounding = { state: "ok", candidates: [c], closedOut: [], queries: [] };
    expect(groundingSummaryOf([g1, g2])!.candidates).toBe(1);
  });
});
