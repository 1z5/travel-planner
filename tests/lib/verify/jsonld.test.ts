import { describe, expect, it } from "vitest";
import { jsonLdScript, planToTouristTripJsonLd } from "@/lib/verify/jsonld";
import type { Plan } from "@/lib/types";

const plan: Plan = {
  city: "成都",
  startDate: "2026-11-01",
  endDate: "2026-11-02",
  summary: "成都两日：宽窄巷子与熊猫基地",
  days: [
    {
      day: 1,
      theme: "老城",
      spots: [
        {
          period: "morning",
          time: "09:00-11:00",
          type: "sight",
          name: "宽窄巷子",
          area: "青羊区",
          durationMin: 120,
          costCny: 0,
          reason: "老成都街区",
        },
        {
          period: "afternoon",
          time: "14:00-16:00",
          type: "food",
          name: "人民公园鹤鸣茶社",
          area: "青羊区",
          durationMin: 120,
          costCny: 60,
          reason: "盖碗茶",
        },
      ],
      transitMin: 0,
      dailyCostCny: 60,
    },
  ],
  totalCostCny: 60,
  tips: [],
  warnings: [],
  verified: false,
  verification: "mock",
};

describe("schema.org TouristTrip JSON-LD", () => {
  it("输出合法的 @type 结构：TouristTrip → ItemList → 每日 subTrip → 景点", () => {
    const ld = planToTouristTripJsonLd(plan);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("TouristTrip");
    expect(String(ld.name)).toContain("成都");
    const itinerary = ld.itinerary as Record<string, unknown>;
    expect(itinerary["@type"]).toBe("ItemList");
    const dayItem = (itinerary.itemListElement as Array<Record<string, unknown>>)[0];
    expect(dayItem.position).toBe(1);
    const dayTrip = dayItem.item as Record<string, unknown>;
    expect(dayTrip["@type"]).toBe("TouristTrip");
    const spots = (dayTrip.itinerary as Record<string, unknown>).itemListElement as Array<
      Record<string, unknown>
    >;
    expect(spots).toHaveLength(2);
    const spot = spots[0].item as Record<string, unknown>;
    expect(spot["@type"]).toBe("TouristAttraction");
    expect(spot.name).toBe("宽窄巷子");
    expect(spot.address).toBe("青羊区");
  });

  it("没有 url 时不写 url；传入时写绝对地址", () => {
    expect(planToTouristTripJsonLd(plan).url).toBeUndefined();
    expect(planToTouristTripJsonLd(plan, { url: "https://example.com/p/x" }).url).toBe(
      "https://example.com/p/x",
    );
  });

  it("缺省日期/城市时不编造字段", () => {
    const bare: Plan = { ...plan, startDate: undefined, endDate: undefined, city: "" };
    const ld = planToTouristTripJsonLd(bare);
    expect(ld.startDate).toBeUndefined();
    expect(ld.endDate).toBeUndefined();
  });

  it("jsonLdScript 把 < 转义，防止用户内容闭合 script 标签（XSS）", () => {
    const evil: Plan = {
      ...plan,
      days: [
        {
          ...plan.days[0],
          spots: [
            {
              ...plan.days[0].spots[0],
              name: "</script><script>alert(1)</script>",
            },
          ],
        },
      ],
    };
    const raw = jsonLdScript(planToTouristTripJsonLd(evil));
    expect(raw).not.toContain("</script>");
    expect(raw).toContain("\\u003c/script>");
    // 仍是合法 JSON
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
