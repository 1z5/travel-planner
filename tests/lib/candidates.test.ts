import { describe, expect, it } from "vitest";
import { buildReplacementSpot, findCandidates } from "@/lib/candidates";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import type { PoiInfo } from "@/lib/amap";

// 候选替换的纯逻辑：只换事实字段（名称/区域/坐标/POI），保留时间/停留/类型。

const poi: PoiInfo = {
  name: "新候选景点",
  address: "成都市新候选路 1 号",
  location: "104.1,30.6",
  adname: "新测试区",
  verified: true,
  rating: 4.6,
  avgCostCny: 88,
  openTime2: "周二至周日 09:00-17:00",
};

describe("buildReplacementSpot", () => {
  it("替换名称/区域/坐标/POI 事实，保留时间轴与类型", () => {
    const oldSpot = SAMPLE_PLAN.days[0]!.spots[0]!;
    const next = buildReplacementSpot(oldSpot, poi);
    expect(next.name).toBe("新候选景点");
    expect(next.area).toBe("新测试区");
    expect(next.location).toBe("104.1,30.6");
    expect(next.time).toBe(oldSpot.time);
    expect(next.period).toBe(oldSpot.period);
    expect(next.type).toBe(oldSpot.type);
    expect(next.durationMin).toBe(oldSpot.durationMin);
    // 人均取高德事实（比原值更准）
    expect(next.costCny).toBe(88);
    expect(next.poi).toEqual({
      rating: 4.6,
      avgCostCny: 88,
      openTime2: "周二至周日 09:00-17:00",
    });
  });

  it("高德缺人均/评分时：人均保留原值，POI 元数据不编（不出现 0 分）", () => {
    const oldSpot = SAMPLE_PLAN.days[0]!.spots[0]!;
    const bare: PoiInfo = {
      name: "裸数据点",
      address: "",
      location: "104.2,30.7",
      adname: "",
      verified: true,
    };
    const next = buildReplacementSpot(oldSpot, bare);
    expect(next.costCny).toBe(oldSpot.costCny);
    expect(next.poi?.rating).toBeUndefined();
    expect(next.poi?.avgCostCny).toBeUndefined();
    // 区域缺失时保留原区域（不能把 area 清空）
    expect(next.area).toBe(oldSpot.area);
  });
});

describe("findCandidates", () => {
  it("MOCK 模式（无高德 key）→ 明确 unavailable，不编候选", async () => {
    const r = await findCandidates(
      SAMPLE_PLAN,
      { city: "成都", days: 3, budget: 2000, preferences: [] },
      1,
      0,
    );
    expect(r.state).toBe("unavailable");
    if (r.state === "unavailable") expect(r.reason).toContain("MOCK");
  });

  it("找不到的站点 → unavailable（不索引越界）", async () => {
    const r = await findCandidates(
      SAMPLE_PLAN,
      { city: "成都", days: 3, budget: 2000, preferences: [] },
      9,
      0,
    );
    expect(r.state).toBe("unavailable");
  });
});
