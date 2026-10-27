import { describe, expect, it } from "vitest";
import { validateRestorePlan, MAX_RESTORE_BYTES } from "@/lib/plan-restore";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 撤销校验：结构与尺寸挡畸形数据，富字段（核验/路段/预警）必须原样保留。

function plan(over: Record<string, unknown> = {}) {
  return { ...SAMPLE_PLAN, ...over };
}

describe("validateRestorePlan", () => {
  it("合法行程：通过，并保留核验/路段/预警等富字段（不剥字段）", () => {
    const p = plan({ verification: "ok", verified: true, warnings: ["w1"], verifiedAt: 123 });
    const r = validateRestorePlan(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.verification).toBe("ok");
    expect(r.plan.verified).toBe(true);
    expect(r.plan.warnings).toEqual(["w1"]);
    expect(r.plan.verifiedAt).toBe(123);
    // 原始对象引用（结构校验不重建内容）
    expect(r.plan).toBe(p);
  });

  it("非对象/数组/null → 拒绝", () => {
    for (const bad of [null, [], "x", 42]) {
      expect(validateRestorePlan(bad).ok).toBe(false);
    }
  });

  it("城市/天数/点位非法 → 拒绝（且错误信息可读）", () => {
    expect(validateRestorePlan(plan({ city: "a" })).ok).toBe(false);
    expect(validateRestorePlan(plan({ days: [] })).ok).toBe(false);
    expect(validateRestorePlan(plan({ days: new Array(11).fill(SAMPLE_PLAN.days[0]) })).ok).toBe(
      false,
    );
    const badSpot = {
      ...SAMPLE_PLAN.days[0],
      spots: [{ ...SAMPLE_PLAN.days[0]!.spots[0]!, type: "unknown-type" }],
    };
    expect(validateRestorePlan(plan({ days: [badSpot] })).ok).toBe(false);
  });

  it("点位名称超长/legs 非数组 → 拒绝", () => {
    const longName = {
      ...SAMPLE_PLAN.days[0],
      spots: [{ ...SAMPLE_PLAN.days[0]!.spots[0]!, name: "x".repeat(81) }],
    };
    expect(validateRestorePlan(plan({ days: [longName] })).ok).toBe(false);
    const badLegs = { ...SAMPLE_PLAN.days[0], legs: "nope" };
    expect(validateRestorePlan(plan({ days: [badLegs] })).ok).toBe(false);
  });

  it("超大 payload → 拒绝（体积上限先于结构校验）", () => {
    const huge = plan({ summary: "x".repeat(MAX_RESTORE_BYTES) });
    expect(validateRestorePlan(huge).ok).toBe(false);
  });
});
