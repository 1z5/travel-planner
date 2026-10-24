import { describe, expect, it } from "vitest";
import { baseLines, dayCityOf, citiesRoute } from "@/lib/planner";
import type { PlanInput } from "@/lib/types";

// 跨城/多城市契约：按天分配城市、逐城验真、城际段不编造。
// 深港是典型场景：高德不做跨境路线，所以「以用户班次为准、不估算通勤」是硬口径。

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "深圳",
    days: 4,
    startAt: "2026-11-01T09:00",
    endAt: "2026-11-04T20:00",
    budget: 3000,
    preferences: ["美食"],
    ...over,
  } as PlanInput;
}

const SZ_HK = [
  { city: "深圳", days: 2 },
  { city: "香港", days: 2 },
];

describe("跨城：按天分配城市", () => {
  it("dayCityOf 按 cities 的 days 累计映射", () => {
    const i = input({ cities: SZ_HK });
    expect(dayCityOf(i, 1)).toBe("深圳");
    expect(dayCityOf(i, 2)).toBe("深圳");
    expect(dayCityOf(i, 3)).toBe("香港");
    expect(dayCityOf(i, 4)).toBe("香港");
    // 越界（防御）：落在最后一座城市，不抛错
    expect(dayCityOf(i, 9)).toBe("香港");
  });

  it("无 cities 时退回单城市（全链路无需判空）", () => {
    expect(dayCityOf(input(), 3)).toBe("深圳");
  });

  it("路线摘要：深圳2天→香港2天", () => {
    expect(citiesRoute(input({ cities: SZ_HK }))).toBe("深圳2天→香港2天");
    expect(citiesRoute(input())).toBe("深圳");
  });
});

describe("跨城：prompt 口径", () => {
  it("给出按天分段的城市表，并要求点位落在当天城市", () => {
    const lines = baseLines(input({ cities: SZ_HK })).join("\n");
    expect(lines).toContain("跨城行程（按天分配城市）：第 1-2 天 深圳；第 3-4 天 香港");
    expect(lines).toContain("每天的点位必须落在当天所属城市");
  });

  it("城际段口径：以用户班次为准，不编造跨境通勤/口岸时间", () => {
    const lines = baseLines(input({ cities: SZ_HK })).join("\n");
    expect(lines).toContain("以用户提供的班次时间为准");
    expect(lines).toContain("不要写具体通勤分钟数");
    expect(lines).toContain("口岸排队");
  });

  it("单城市行程不带跨城行（向后兼容红线）", () => {
    const lines = baseLines(input()).join("\n");
    expect(lines).not.toContain("跨城行程");
    expect(lines).toContain("目的地：深圳");
  });
});
