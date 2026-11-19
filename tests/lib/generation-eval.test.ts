import { describe, expect, it } from "vitest";
import { SAMPLE_PLAN } from "@/lib/demo/sample-plan";
import { measurePlan } from "../../scripts/lib/eval-plan";

describe("生成评测快照", () => {
  it("用已展示的站点评估费用和开始时间，缺少地图资料时保持未知", () => {
    const firstDay = SAMPLE_PLAN.days[0]!;
    const firstSpot = firstDay.spots[0]!;
    const metrics = measurePlan(
      {
        ...SAMPLE_PLAN,
        verified: false,
        verification: "mock",
        totalCostCny: 0,
        days: [{ ...firstDay, spots: [{ ...firstSpot, costCny: 125 }], legs: undefined }],
      },
      3,
      { budget: 500, startAt: "2026-11-20T10:00", endAt: "2026-11-22T18:00" },
    );
    expect(metrics).toMatchObject({
      plannedDays: [1],
      complete: false,
      visibleCostCny: 125,
      budgetPercent: 25,
      windowViolations: 1,
      factsState: "unverified",
      coverage: { poiHit: 0, poiTotal: 1, hoursChecked: 0 },
    });
  });
});
