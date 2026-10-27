import type { Plan, PlanDay, PlanSpot } from "./types";

// ============================================================
// 「撤销这次修改」的服务端校验（产品线 A4 延伸）
//
// 为什么需要：修改可能把行程改坏（换的点位通勤更远、顺延后反而更紧）。
// 用户点「撤销」时，前端把**修改前那一版 plan**（本来就从服务端拿到的）发回来，
// 服务端校验后落库成新版本。
//
// 为什么不用 lib/planner 的 PlanSchema：那是「LLM 输出」的 schema，只覆盖生成
// 必需的字段（city/summary/days/spots/totalCostCny/tips），会把 verified/
// verification/warnings/legs/grounding 等**核验与执行态字段全剥掉**——撤销后
// 行程会变成「未核验」，等于把用户已经拿到的可信信息删了。
//
// 校验口径（与「不猜」一致）：
// 1. 只校验**结构与尺寸**（防超大 payload / 畸形数据写坏存储），不重建内容；
// 2. 未知但合法的富字段一律保留（passthrough），不静默丢数据；
// 3. 尺寸上限都写死在这里，单测覆盖边界（超长名称/超多天/超多点位）。
// ============================================================

/** 单次撤销允许的最大 JSON 体积（正常行程 ~50KB；300KB 足够且防滥用） */
export const MAX_RESTORE_BYTES = 300_000;

const SPOT_TYPES = ["sight", "food", "hotel", "transport", "shopping", "activity"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown, min: number, max: number): v is string {
  return typeof v === "string" && v.length >= min && v.length <= max;
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function validSpot(v: unknown): v is PlanSpot {
  if (!isObj(v)) return false;
  return (
    isStr(v.name, 1, 80) &&
    isStr(v.time, 1, 20) &&
    typeof v.type === "string" &&
    (SPOT_TYPES as readonly string[]).includes(v.type) &&
    isStr(v.period, 1, 20) &&
    isStr(v.area, 0, 60) &&
    isNum(v.durationMin) &&
    isNum(v.costCny) &&
    isStr(v.reason, 0, 500)
  );
}

function validDay(v: unknown): v is PlanDay {
  if (!isObj(v)) return false;
  if (!isNum(v.day) || !Number.isInteger(v.day)) return false;
  if (!isStr(v.theme, 0, 60)) return false;
  if (!Array.isArray(v.spots) || v.spots.length > 20) return false;
  if (!v.spots.every(validSpot)) return false;
  // legs 可选：有就必须是数组（内容交给渲染层降级，这里只挡畸形结构）
  if (v.legs !== undefined && !Array.isArray(v.legs)) return false;
  if (Array.isArray(v.legs) && v.legs.length > 20) return false;
  return true;
}

export type RestoreValidation = { ok: true; plan: Plan } | { ok: false; error: string };

/** 校验客户端回传的「上一版行程」；通过则原样返回（保留核验/路段等富字段） */
export function validateRestorePlan(value: unknown): RestoreValidation {
  // 体积上限放在结构校验之前：避免超大 JSON 先被逐字段遍历（DoS 面）
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    return { ok: false, error: "行程数据无法序列化" };
  }
  if (size > MAX_RESTORE_BYTES) return { ok: false, error: "行程数据过大" };
  if (!isObj(value)) return { ok: false, error: "行程数据格式不正确" };
  if (!isStr(value.city, 2, 20)) return { ok: false, error: "城市名不合法" };
  if (!isStr(value.summary, 0, 500)) return { ok: false, error: "行程概览不合法" };
  if (!isNum(value.totalCostCny)) return { ok: false, error: "总花费不合法" };
  if (!Array.isArray(value.tips) || value.tips.length > 20) {
    return { ok: false, error: "提示列表不合法" };
  }
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 10) {
    return { ok: false, error: "天数不合法" };
  }
  if (!value.days.every(validDay)) return { ok: false, error: "行程点数据不合法" };
  // 校验通过：保留原始对象（含 warnings/verification/legs/grounding 等富字段）
  return { ok: true, plan: value as unknown as Plan };
}
