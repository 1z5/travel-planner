import { describe, expect, it } from "vitest";
import { tokyoLocalTrip } from "../../../demo/fixtures/tokyo-local";
import { verifyDocument } from "@/lib/verify/engine";
import { localPlanCheckInput } from "@/lib/verify/local-plan";

describe("本机行程体检", () => {
  it("使用东京城市包的季节开放时间，保留公园时间和路线的未知状态", () => {
    const plan = tokyoLocalTrip(new Date("2026-11-19T00:00:00Z"));
    plan.days[0]!.spots[0]!.time = "06:00-06:15";
    const input = localPlanCheckInput(plan);
    const report = verifyDocument(input.document);
    expect(input.references.map(({ id }) => id)).toEqual(["senso-ji", "sumida-park-taito"]);
    expect(report.verdict.facts.state).toBe("partial");
    expect(report.verdict.facts.coverage).toMatchObject({
      poiChecked: 2,
      hoursChecked: 1,
      routesTotal: 1,
      routesChecked: 0,
    });
    expect(report.issues.some(({ ruleId }) => ruleId === "TC-F204")).toBe(true);

    plan.startDate = "2026-07-19";
    const summer = verifyDocument(localPlanCheckInput(plan).document);
    expect(summer.issues.some(({ ruleId }) => ruleId === "TC-F204")).toBe(false);
  });

  it("不会把来源字段、错误坐标或城市不明当成匹配证据", () => {
    const plan = tokyoLocalTrip();
    const [temple, park] = plan.days[0]!.spots;
    temple!.location = "0,0";
    park!.navigationQuery = "另一个同名地点";
    const input = localPlanCheckInput(plan);
    expect(input.references).toHaveLength(0);
    expect(verifyDocument(input.document).verdict.facts.state).toBe("unverified");

    const multiCity = tokyoLocalTrip();
    multiCity.cities = [
      { city: "东京", days: 1 },
      { city: "京都", days: 1 },
    ];
    expect(localPlanCheckInput(multiCity).references).toHaveLength(0);
  });
});
