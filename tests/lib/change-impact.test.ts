import { describe, expect, it } from "vitest";
import type { Plan } from "@/lib/types";
import { changeImpact } from "@/lib/change-impact";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 「改一次，验一次」的效果对比：数字复用可执行性评分；变差也要如实说。

function verifiedPlan(over: Partial<Plan> = {}): Plan {
  return {
    ...SAMPLE_PLAN,
    verified: true,
    verification: "ok",
    warnings: [],
    ...over,
  };
}

describe("changeImpact", () => {
  it("风险降低 → 报告「本次修复」与分数提升、问题条数变化", () => {
    const before = verifiedPlan({
      warnings: [
        "第 1 天有 1 段「时间接不上」：A 结束到 B 只有 10 分钟，但步行约需 20 分钟，可用「一键顺延」重排",
        "第 1 天站点间通勤约 3 小时，偏长，可能存在绕路，建议合并同区域景点",
      ],
    });
    const after = verifiedPlan();
    const impact = changeImpact(before, after, "adjust");
    expect(impact.kind).toBe("adjust");
    expect(impact.scoreAfter!).toBeGreaterThan(impact.scoreBefore!);
    expect(impact.warningsBefore).toBe(2);
    expect(impact.warningsAfter).toBe(0);
    expect(impact.summary).toContain("本次修复");
    expect(impact.summary).toContain("（+");
    expect(impact.summary).toMatch(/可执行性 [ABCD]\(\d+\) → [ABCD]\(\d+\)/);
  });

  it("风险未变化 → 如实说「风险未变化」，不冒充改善", () => {
    const before = verifiedPlan();
    const after = verifiedPlan();
    const impact = changeImpact(before, after, "refine");
    expect(impact.summary).toContain("风险未变化");
    expect(impact.summary).not.toContain("本次修复");
  });

  it("变差 → 明确提示「这次改动没有让行程更稳」（禁止只报喜）", () => {
    const before = verifiedPlan();
    const after = verifiedPlan({
      warnings: [
        "第 1 天有 2 段「时间接不上」：可用「一键顺延」重排当天时间轴",
        "第 1 天「某店」计划 16:15-17:15，但 营业时间 11:00-13:30，营业时间对不上",
      ],
    });
    const impact = changeImpact(before, after, "refine");
    expect(impact.scoreAfter!).toBeLessThan(impact.scoreBefore!);
    expect(impact.summary).toContain("注意");
    expect(impact.summary).toContain("没有让行程更稳");
  });

  it("MOCK/未核验 → 不评假分，只报体检问题条数", () => {
    const before = verifiedPlan({ verified: false, verification: "mock" });
    const after = verifiedPlan({ verified: false, verification: "mock" });
    const impact = changeImpact(before, after, "adjust");
    expect(impact.scoreBefore).toBeNull();
    expect(impact.scoreAfter).toBeNull();
    expect(impact.summary).toContain("未接高德核验");
    expect(impact.summary).toContain("体检问题");
  });
});
