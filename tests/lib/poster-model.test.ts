import { describe, expect, it } from "vitest";
import type { Plan } from "@/lib/types";
import { buildPosterModel } from "@/lib/poster-model";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 海报模型：数字必须与页面同源（lib/budget.ts），三态必须诚实。
function plan(over: Partial<Plan> = {}): Plan {
  return { ...SAMPLE_PLAN, ...over };
}

describe("buildPosterModel", () => {
  it("KPI 与页面同源：天数/站点/人均总花费 + 预算使用率（有预算才给）", () => {
    const p = plan({ budgetCny: 2000 });
    const m = buildPosterModel(p);
    const labels = m.kpis.map((k) => k.label);
    expect(labels).toEqual(["天", "站", "人均总花费", "预算使用率"]);
    const spots = p.days.reduce((n, d) => n + d.spots.length, 0);
    expect(m.kpis[0]?.value).toBe(String(p.days.length));
    expect(m.kpis[1]?.value).toBe(String(spots));
    expect(m.kpis[3]?.value).toMatch(/^\d+%$/);
  });

  it("旧数据没有预算 → 使用率 KPI 与预算行都不渲染（不猜）", () => {
    const m = buildPosterModel(plan({ budgetCny: undefined }));
    expect(m.kpis.map((k) => k.label)).not.toContain("预算使用率");
    expect(m.budgetLine).toBeNull();
  });

  it("highlights：优先景点/餐饮，跳过住宿/交通占位，最多 4 个", () => {
    const p = plan({
      days: [
        {
          day: 1,
          theme: "t",
          transitMin: 0,
          dailyCostCny: 0,
          spots: [
            { ...SAMPLE_PLAN.days[0]!.spots[0]!, type: "hotel", name: "苏州饭店" },
            { ...SAMPLE_PLAN.days[0]!.spots[0]!, time: "09:00-11:30", name: "虎丘" },
            {
              ...SAMPLE_PLAN.days[0]!.spots[0]!,
              type: "food",
              time: "12:00-13:00",
              name: "朱鸿兴面馆",
            },
            { ...SAMPLE_PLAN.days[0]!.spots[0]!, type: "transport", name: "苏州站" },
          ],
        },
      ],
    });
    const m = buildPosterModel(p);
    expect(m.highlights).toEqual([
      { time: "09:00", name: "虎丘" },
      { time: "12:00", name: "朱鸿兴面馆" },
    ]);
  });

  it("日期文本：有起止 → 「M月D日 → M月D日」；没有 → null", () => {
    expect(
      buildPosterModel(plan({ startDate: "2026-11-09", endDate: "2026-11-11" })).dateText,
    ).toBe("11月9日 → 11月11日");
    expect(
      buildPosterModel(plan({ startDate: undefined, endDate: undefined })).dateText,
    ).toBeNull();
  });

  it("三态文案：ok/partial/pending/mock 各不相同，mock 明确「未经核验」", () => {
    expect(buildPosterModel(plan({ verification: "ok", verified: true })).verifyLine).toBe(
      "POI 已通过高德验真",
    );
    expect(buildPosterModel(plan({ verification: "partial" })).verifyLine).toBe(
      "部分 POI 未能核验",
    );
    expect(buildPosterModel(plan({ verification: "pending" })).verifyLine).toBe("核验进行中");
    const mock = buildPosterModel(plan({ verification: "mock", verified: false }));
    expect(mock.verifyLine).toContain("未经核验");
  });

  it("不修改传入的 plan（纯函数）", () => {
    const p = plan();
    const before = JSON.stringify(p);
    buildPosterModel(p);
    expect(JSON.stringify(p)).toBe(before);
  });
});
