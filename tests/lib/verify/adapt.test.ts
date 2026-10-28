import { describe, expect, it } from "vitest";
import { addDaysIso, planToDocument } from "@/lib/verify/adapt";
import { verifyDocument } from "@/lib/verify/engine";
import type { Plan } from "@/lib/types";

function basePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    startDate: "2026-11-03",
    endDate: "2026-11-03",
    summary: "苏州一日",
    days: [
      {
        day: 1,
        theme: "古城",
        spots: [
          {
            period: "morning",
            time: "09:00-11:00",
            type: "sight",
            name: "拙政园",
            area: "姑苏区",
            durationMin: 120,
            costCny: 80,
            reason: "经典园林",
            location: "120.629,31.324",
            poi: {
              rating: 4.8,
              openTime: "周一至周日 07:30-17:30",
            },
          },
          {
            period: "afternoon",
            time: "13:00-15:00",
            type: "sight",
            name: "苏州博物馆",
            area: "姑苏区",
            durationMin: 120,
            costCny: 0,
            reason: "贝聿铭设计",
            location: "120.628,31.322",
            poi: { openTime2: "周二至周日 09:00-17:00 周一闭馆" },
          },
        ],
        transitMin: 20,
        dailyCostCny: 80,
        legs: [
          {
            from: "拙政园",
            to: "苏州博物馆",
            mode: "walking",
            distanceM: 1200,
            durationSec: 1150,
            steps: ["向东步行"],
          },
        ],
      },
    ],
    totalCostCny: 80,
    tips: [],
    warnings: [],
    verified: true,
    verification: "ok",
    verifiedAt: new Date("2026-10-27T10:00:00.000Z").getTime(),
    ...overrides,
  };
}

describe("planToDocument · 三态映射", () => {
  it("已核验计划：location→existence hit、营业时间原文→hours hit、legs→durationMin 向上取整", () => {
    const doc = planToDocument(basePlan(), { id: "share_x" });
    expect(doc.id).toBe("share_x");
    expect(doc.specVersion).toBe("trip-check/0.1");
    expect(doc.days[0].date).toBe("2026-11-03");
    const [garden, museum] = doc.days[0].spots;
    expect(garden.verification?.existence).toBe("hit");
    expect(garden.verification?.hours).toBe("hit");
    expect(garden.hours?.openTime).toContain("07:30");
    expect(museum.verification?.hours).toBe("hit"); // openTime2 也算营业时间原文
    expect(doc.days[0].legs?.[0].durationMin).toBe(20); // 1150s → 20min（向上取整）
    expect(doc.provenance?.poi?.source).toBe("amap");
    expect(doc.provenance?.routes?.source).toBe("amap");
  });

  it("MOCK 计划：不能声明 hit（否则就是拿演示数据冒充真实核验）", () => {
    const mock = basePlan({
      verified: false,
      verification: "mock",
      verifiedAt: undefined,
      days: [
        {
          ...basePlan().days[0],
          spots: [
            {
              period: "morning",
              time: "09:00-11:00",
              type: "sight",
              name: "某景点",
              area: "某区",
              durationMin: 120,
              costCny: 50,
              reason: "示例",
            },
          ],
          legs: undefined,
        },
      ],
    });
    const doc = planToDocument(mock);
    const spot = doc.days[0].spots[0];
    expect(spot.verification?.existence).toBe("not_checked");
    expect(spot.verification?.hours).toBe("not_checked");
    expect(doc.provenance?.poi?.source).toBe("mock");
    const report = verifyDocument(doc);
    expect(report.verdict.facts.state).toBe("unverified");
  });

  it("partial（上游波动）不能把剩余点位标成 hit/miss", () => {
    const partial = basePlan({ verification: "partial" });
    const doc = planToDocument(partial);
    // location 是已命中时回填的，仍可标 hit；但没坐标/没营业时间的点不能标 miss
    expect(doc.days[0].spots[0].verification?.existence).toBe("hit");
    const noLocation = basePlan({
      verification: "partial",
      days: [
        {
          ...basePlan().days[0],
          spots: [
            {
              period: "morning",
              time: "09:00-11:00",
              type: "sight",
              name: "没核到的点",
              area: "某区",
              durationMin: 60,
              costCny: 0,
              reason: "示例",
            },
          ],
          legs: undefined,
        },
      ],
    });
    const doc2 = planToDocument(noLocation);
    expect(doc2.days[0].spots[0].verification?.existence).toBe("not_checked");
  });

  it("验真完成但坐标缺失 → 标 miss（查询过、源没有），不是 not_checked", () => {
    const plan = basePlan();
    plan.days[0].spots[1] = { ...plan.days[0].spots[1], location: undefined };
    const doc = planToDocument(plan);
    expect(doc.days[0].spots[1].verification?.existence).toBe("miss");
  });

  it("warnings 里的「未在高德检索到」能精确映射成 miss（不误伤同名其它点）", () => {
    const plan = basePlan({
      warnings: ["第 1 天「拙政园」未在高德检索到，可能名称有误或已关闭，出发前请自行确认"],
    });
    plan.days[0].spots[0] = { ...plan.days[0].spots[0], location: undefined };
    const doc = planToDocument(plan);
    expect(doc.days[0].spots[0].verification?.existence).toBe("miss");
  });

  it("日期按 startDate + day-1 推算；startDate 非法就不写 date（不猜）", () => {
    expect(addDaysIso("2026-11-03", 0)).toBe("2026-11-03");
    expect(addDaysIso("2026-11-03", 2)).toBe("2026-11-05");
    expect(addDaysIso("2026-02-29", 0)).toBeUndefined(); // 2026 不是闰年
    expect(addDaysIso(undefined, 1)).toBeUndefined();
    const plan = basePlan({ startDate: undefined });
    delete plan.startDate;
    const doc = planToDocument(plan);
    expect(doc.days[0].date).toBeUndefined();
  });

  it("已核验计划经 engine 判定：facts=verified（适配层与引擎口径闭环）", () => {
    const report = verifyDocument(planToDocument(basePlan()));
    expect(report.verdict.facts.state).toBe("verified");
  });
});
