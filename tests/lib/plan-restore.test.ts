import { describe, expect, it } from "vitest";
import {
  MAX_RESTORE_BYTES,
  RESTORE_TRUSTED_FIELDS,
  sanitizeRestoredPlan,
  validateRestorePlan,
} from "@/lib/plan-restore";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 撤销校验：结构与尺寸挡畸形数据；**服务端受信字段一律剥离**（安全审计 R5）。
// 内容字段（days/spots/legs/tips/totalCostCny）保留——撤销不该丢用户已有的行程内容。

function plan(over: Record<string, unknown> = {}) {
  return { ...SAMPLE_PLAN, ...over };
}

/** 客户端伪造的一整套「可信证据」：核验结论 + 修复凭据链 + 生成期证据 + 预警 */
const FORGED = {
  verified: true,
  verification: "ok",
  verifiedAt: 123,
  grounding: { candidates: 99, closedSkipped: 0, closedOut: 0 },
  verificationReport: { fastDraftSpots: 9 },
  tripCheck: { credentialId: "tc_fake", parentCredentialId: "tc_parent_fake", checkedAt: 1 },
  demo: false,
  warnings: ["伪造的预警文案"],
};

describe("validateRestorePlan", () => {
  it("合法行程：通过，但剥离客户端回传的受信字段（不能伪造已核验/已修复）", () => {
    const p = plan(FORGED);
    const r = validateRestorePlan(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const field of RESTORE_TRUSTED_FIELDS) {
      // 例外：verified 剥离后显式写回 false；warnings 剥离后显式写回空数组
      // （两者都是「下游契约要求字段存在」的字段，见 sanitizeRestoredPlan）
      if (field === "verified" || field === "warnings") continue;
      expect(r.plan, `受信字段 ${field} 必须被剥离`).not.toHaveProperty(field);
    }
    // 显式标记未核验（不是靠字段缺失让下游猜语义）
    expect(r.plan.verified).toBe(false);
    expect(r.plan.verification).toBeUndefined();
    expect(r.plan.tripCheck).toBeUndefined();
    // warnings 被清空（客户端文案不可信），由 restore 路由用 refreshTimeWarnings 重算
    expect(r.plan.warnings).toEqual([]);
    // 不修改入参
    expect(p.verified).toBe(true);
    expect(p.tripCheck).toEqual(FORGED.tripCheck);
  });

  it("内容字段原样保留：days/spots/legs/tips/总花费（含 spot 的历史 poi/location 内容）", () => {
    const withPoi = {
      ...SAMPLE_PLAN,
      days: SAMPLE_PLAN.days.map((day, i) =>
        i === 0
          ? {
              ...day,
              spots: day.spots.map((spot, j) =>
                j === 0
                  ? {
                      ...spot,
                      location: "120.629,31.324",
                      poi: { rating: 4.8, openTime: "09:00-17:00" },
                    }
                  : spot,
              ),
            }
          : day,
      ),
    };
    const r = validateRestorePlan(withPoi);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.days).toEqual(withPoi.days);
    expect(r.plan.days[0]!.spots[0]!.poi).toEqual({ rating: 4.8, openTime: "09:00-17:00" });
    expect(r.plan.totalCostCny).toBe(SAMPLE_PLAN.totalCostCny);
    expect(r.plan.tips).toEqual(SAMPLE_PLAN.tips);
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

describe("sanitizeRestoredPlan", () => {
  it("剥离范围是封闭清单（新增服务端状态字段时必须显式加入）", () => {
    expect([...RESTORE_TRUSTED_FIELDS]).toEqual([
      "verified",
      "verification",
      "verifiedAt",
      "grounding",
      "verificationReport",
      "tripCheck",
      "demo",
      "warnings",
    ]);
  });

  it("幂等：对已净化 plan 再净化结果不变", () => {
    const once = sanitizeRestoredPlan(plan(FORGED));
    const twice = sanitizeRestoredPlan(once);
    expect(twice).toEqual(once);
  });
});
