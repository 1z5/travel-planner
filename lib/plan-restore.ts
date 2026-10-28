import type { Plan, PlanDay, PlanSpot } from "./types";

// ============================================================
// 「撤销这次修改」的服务端校验与信任边界（产品线 A4 延伸）
//
// 为什么需要：修改可能把行程改坏（换的点位通勤更远、顺延后反而更紧）。
// 用户点「撤销」时，前端把**修改前那一版 plan**（本来就从服务端拿到的）发回来，
// 服务端校验后落库成新版本。
//
// 为什么不用 lib/planner 的 PlanSchema：那是「LLM 输出」的 schema，只覆盖生成
// 必需的字段（city/summary/days/spots/totalCostCny/tips），会把 legs 等执行态
// 字段全剥掉——撤销后行程会丢失已经算好的真实路段。
//
// **信任边界（安全审计 R5）**：撤销的输入是客户端手里的副本，不是服务端存的
// 权威版本。所以本模块做两件事：
// 1. 校验结构与尺寸（防超大 payload / 畸形数据写坏存储）；
// 2. **剥离服务端受信字段**（核验结论/修复凭据链/生成期证据/demo 标记/预警），
//    把 plan 标成未核验。否则持 token 者可伪造「已核验/已修复」徽章——见
//    RESTORE_TRUSTED_FIELDS 的逐字段理由。
// warnings 不在这里算（需要 plan 维度的时间轴/营业时间重算）——由 restore 路由
// 用 lib/validate.ts 的 refreshTimeWarnings 服务端重算。
//
// 校验口径（与「不猜」一致）：
// 1. 只校验结构与尺寸，不重建内容；
// 2. 内容字段（days/spots/legs/poi/location…）原样保留，不静默丢数据；
// 3. 尺寸上限写死在这里，单测覆盖边界（超长名称/超多天/超多点位）。
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

/**
 * 客户端回传里**不可信**的服务端状态字段（安全审计 R5）。
 *
 * 为什么信任边界在这里：分享 token 只证明「你拿到链接」，不证明「你拿到的这份
 * JSON 是我们服务端核验/修复过的」。撤销的输入是整份 plan（客户端 localStorage
 * 里的副本），如果原样落库，持 token 的人就能把 `verified/verification/tripCheck`
 * 改成任意值——分享页立刻显示伪造的「POI 已核验」「已确定性修复 + 假凭据链」，
 * 直接击穿「可复算证据」的整个叙事。
 *
 * 剥离范围与理由：
 * - `verified/verification/verifiedAt`：核验结论只能由服务端验真链路写；
 * - `tripCheck/verificationReport`：修复凭据链/核验差异报告同理，客户端无法自证；
 * - `grounding`：事实先行摘要属于生成期证据，撤销不是生成；
 * - `demo`：服务端只读标记，不能被客户端伪造（也不能靠撤销给自己加/去掉锁）；
 * - `warnings`：清空后由路由用 refreshTimeWarnings 服务端重算。
 *
 * spot 级 `poi/location` **保留内容**（它们是历史验真数据，删了会把用户已经拿到
 * 的真实信息删掉），但整份 plan 明确标成 `verified:false` 且不带 verification——
 * 「数据还在这，但这次撤销不再宣称它被核验过」，诚实优先于便利。
 */
export const RESTORE_TRUSTED_FIELDS = [
  "verified",
  "verification",
  "verifiedAt",
  "grounding",
  "verificationReport",
  "tripCheck",
  "demo",
  "warnings",
] as const;

/** 剥离客户端回传的受信字段（返回新对象；不修改入参），并标记整份 plan 未核验 */
export function sanitizeRestoredPlan(plan: Plan): Plan {
  const clean: Record<string, unknown> = { ...plan };
  for (const field of RESTORE_TRUSTED_FIELDS) delete clean[field];
  // 剥离后显式写「未核验」：不能靠「字段缺失」让下游各自猜语义
  clean.verified = false;
  // warnings 给空数组（不是 undefined）：路由会用 refreshTimeWarnings 填回；
  // 保底也保证「plan.warnings 永远是数组」这个下游契约不被这次剥离打破。
  clean.warnings = [];
  return clean as unknown as Plan;
}

/**
 * 校验客户端回传的「上一版行程」。
 *
 * 通过后返回的是**已剥离受信字段**的 plan（结构/内容字段原样保留：days/spots/
 * totalCostCny/tips/legs 等）。调用方（restore 路由）只需再补 warnings。
 */
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
  // 校验通过：结构/内容保留，但受信字段一律剥离后再交给落库路径
  return { ok: true, plan: sanitizeRestoredPlan(value as unknown as Plan) };
}
