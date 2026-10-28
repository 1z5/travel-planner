import { NextRequest } from "next/server";
import { resolvePlan } from "@/lib/plan-repo";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";
import { planToDocument } from "@/lib/verify/adapt";
import { credentialOf } from "@/lib/verify/credential";
import { repairDocument } from "@/lib/verify/repair";
import type { TripCheckDocument, TripCheckOptions } from "@/lib/verify/types";
import { parseVerifyRequest } from "@/lib/verify/validate";
import { emptyWithCors, jsonWithCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/verify/repair —— Trip Check 确定性修复 API
//
// 判定闭环的另一半：/api/verify 说「哪里走不通」，这里做**有数据依据、不改语义**的
// 机械修复（顺延时间消除重叠/接不上、删同一天重复点位），再用同一套引擎重验，
// 并用**前后两张可复算凭据**把「改了什么、风险降了多少」变成可对账的事实。
//
// 几条硬约束（与 lib/verify/repair.ts 的铁律同源）：
// 1) **不编造事实**：不加地点、不改营业时间、不补路段耗时；修不了（缺数据/24:00 边界/
//    预算节奏等涉及取舍的问题）逐条进 unrepairable，绝不悄悄改。
// 2) **不写回存储**：shareId 路径只读 Plan → 内存里修 → 返回；响应里 persisted:false
//    明示「这是一份建议，采用与否由用户/调用方决定」（与行中 replan 的「建议不落库」同口径）。
// 3) **前后可比**：before/after 用同一个 options + 同一个 now（时间只进 checkedAt/
//    issuedAt，不参与判定），且 parentCredential 对应**输入文档**、credential 对应**修复后
//    文档**——调用方可以拿任意一张去 /api/verify 独立复算对账。
//
// body 契约与 /api/verify 完全一致（document 或 shareId 二选一 + options），错误码
// 也保持一致；下面第 1-3 步是**有意重复**的（本任务只允许改 app/api/verify/repair/**
// 与切片/文档，不能抽公共模块改已上线的 /api/verify；两处契约必须同步，改一处要同步另一处）。
// ============================================================

/** 请求体上限 256 KiB：与 /api/verify 同口径（开放文档的合理规模远小于此） */
const MAX_BODY_BYTES = 256 * 1024;

type RepairSource = "document" | "share";

/**
 * GET /api/verify/repair —— 不提供（修复是无状态一次性计算，没有可查询的结果）。
 * 回 405 + 可读说明与 Allow 头，而不是让框架回一页 HTML 405：调用方是代码/agent。
 */
export async function GET() {
  return jsonWithCors(
    {
      error: "method_not_allowed",
      detail:
        "本端点只支持 POST。body 与 /api/verify 相同：{ document } 或 { shareId }（二选一），可选 { options: { pace } }。修复是确定性计算、不写回任何存储，因此没有 GET 查询入口。",
    },
    405,
    { Allow: "POST, OPTIONS", "Access-Control-Allow-Methods": "POST,OPTIONS" },
  );
}

/** OPTIONS /api/verify/repair —— CORS 预检（浏览器跨域调用前必过） */
export async function OPTIONS() {
  return emptyWithCors(204);
}

export async function POST(req: NextRequest) {
  // 1) body 只读一次：先量 UTF-8 字节（>256KiB → 413），再 JSON.parse（失败 400）。
  //    与 /api/verify 的语义完全一致：413/400 必须可区分，不能解析器崩成 500。
  let text: string;
  try {
    text = await req.text();
  } catch {
    return jsonWithCors({ error: "invalid_json" }, 400);
  }

  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return jsonWithCors({ error: "payload_too_large", limit: MAX_BODY_BYTES }, 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonWithCors({ error: "invalid_json" }, 400);
  }

  // 2) 契约校验（zod）：错误的 errors[].path 让调用方/agent 能定位到具体字段
  const parsed = parseVerifyRequest(raw);
  if (!parsed.ok) {
    return jsonWithCors({ error: "invalid_request", errors: parsed.errors }, 400);
  }
  const { document: submitted, shareId, options } = parsed.value;

  // 3) 按 IP 小时桶限流：修复是 CPU 计算 + 可能读存储，单独一个桶（verify-repair），
  //    额度与体检同量级（VERIFY_HOURLY_LIMIT，默认 120/h）。坏请求不扣额度。
  const rl = await checkProxyRateLimit(req.headers, "verify-repair", "VERIFY_HOURLY_LIMIT", 120);
  if (!rl.allowed) {
    return jsonWithCors({ error: "rate_limited", limit: rl.limit }, 429);
  }

  // 4) 同一个 now 贯穿：before/after 两份报告 + 两张凭据（时间不参与判定，只进时间戳）
  const now = new Date();

  try {
    if (shareId) {
      // 分享 token → 持久化 Plan → 开放文档 → 修复建议。**不写回**：Plan 的修改入口
      // 是产品侧（/api/plan/refine 等），开放修复层只产出建议，不越权改用户行程。
      const plan = await resolvePlan(shareId);
      if (!plan) {
        return jsonWithCors({ error: "not_found" }, 404);
      }
      const doc = planToDocument(plan, { id: shareId });
      return jsonWithCors(repairResponse(doc, options, now, "share"));
    }

    if (submitted) {
      return jsonWithCors(repairResponse(submitted, options, now, "document"));
    }

    // parseVerifyRequest 已保证二选一；走到这里说明校验契约变了，明确 400 便于排障
    return jsonWithCors(
      {
        error: "invalid_request",
        errors: [{ path: "document", message: "document 与 shareId 必须且只能提供一个" }],
      },
      400,
    );
  } catch (e) {
    // 修复器/存储理论上不会抛；兜底成 JSON 错误（调用方需要可解析的错误体）
    console.error(`[verify/repair] 修复失败: ${(e as Error)?.message ?? e}`);
    return jsonWithCors({ error: "internal_error" }, 500);
  }
}

/**
 * 组装 200 响应：RepairResult 全量字段 + 语义标记 + 前后凭据链。
 *
 * @param inputDoc 输入文档（parentCredential 的复算对象，必须是**参与修复的同一份**
 *                 规范文档——调用方拿它去 /api/verify 应得到同一个 parentCredential.id）
 * @param now      before/after/两张凭据共用的时间（只影响时间戳字段）
 */
function repairResponse(
  inputDoc: TripCheckDocument,
  options: TripCheckOptions,
  now: Date,
  source: RepairSource,
) {
  const result = repairDocument(inputDoc, options, now);
  return {
    ...result,
    // applied 为空 = 本来就没得修/不需要修。显式给 changed 而不是让调用方自己数数组，
    // 是因为 UI/agent 的第一判断就是「有没有改动」，这个语义不该各端重复推导。
    changed: result.applied.length > 0,
    // 修复层没有写回存储：shareId 路径的 Plan 保持原样（响应必须自证这一点）
    persisted: false as const,
    source,
    // 前后凭据链：parent = 输入文档，credential = 修复后文档。
    // 同一 now 只影响 issuedAt；ID 只由「文档+口径+引擎/规则版本」决定，因此可独立复算。
    parentCredential: credentialOf(inputDoc, options, now),
    credential: credentialOf(result.document, options, now),
  };
}
