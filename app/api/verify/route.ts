import { NextRequest } from "next/server";
import { resolvePlan } from "@/lib/plan-repo";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";
import { planToDocument } from "@/lib/verify/adapt";
import { credentialOf } from "@/lib/verify/credential";
import { verifyDocument } from "@/lib/verify/engine";
import {
  TRIP_CHECK_ENGINE_NAME,
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckDocument,
  type TripCheckOptions,
} from "@/lib/verify/types";
import { parseVerifyRequest } from "@/lib/verify/validate";
import { emptyWithCors, jsonWithCors } from "./cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/verify —— Trip Check 公开体检 API（deterministic，不调模型）
//
// 两种输入二选一：
// - { document }：任何第三方 AI 生成的行程（开放格式见 GET /api/verify/schema）；
// - { shareId } ：本站持久化行程（分享 token），内部 Plan → 开放文档后同一引擎复算。
//
// 为什么两条路径必须走**同一套** engine/credential：如果「自家行程」另开一套
// 判定，公开标准就是假的。适配层（adapt.ts）只搬事实与三态，判定口径不变。
//
// 为什么限流放在参数校验之后：畸形请求不该消耗调用方的小时额度（与
// lib/proxy-rate-limit.ts 服务的只读代理端点同口径）。
//
// 为什么 body 先量字节再 JSON.parse：这是公开端点，调用方可能是脚本/agent；
// 400（invalid_json/invalid_request）与 413（payload_too_large）必须可区分，
// 不能让超限请求在解析器里变成 500。
// ============================================================

/** 请求体上限 256 KiB：开放文档的合理规模（30 天 × 40 点位）远小于此 */
const MAX_BODY_BYTES = 256 * 1024;

/** GET /api/verify —— 服务元信息（机器可发现：schema 地址、规范/引擎/规则版本） */
export async function GET() {
  return jsonWithCors({
    name: TRIP_CHECK_ENGINE_NAME,
    specVersion: TRIP_CHECK_SPEC_VERSION,
    engineVersion: TRIP_CHECK_ENGINE_VERSION,
    rulesetVersion: TRIP_CHECK_RULESET_VERSION,
    schema: "/api/verify/schema",
    docs: "/verify",
  });
}

/** OPTIONS /api/verify —— CORS 预检（浏览器跨域调用前必过） */
export async function OPTIONS() {
  return emptyWithCors(204);
}

export async function POST(req: NextRequest) {
  // 1) body 只读一次：NextRequest 的 body 是流，读两次会抛。
  //    读失败按「非法 JSON」处理（客户端中断/编码问题，不是服务端 500）。
  let text: string;
  try {
    text = await req.text();
  } catch {
    return jsonWithCors({ error: "invalid_json" }, 400);
  }

  // 2) 按 UTF-8 字节数判断上限：body 上限的语义是网络传输量，不是字符数
  //    （中文一行 3 字节；按 length 判会让同样的字节数在不同语言下待遇不同）。
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return jsonWithCors({ error: "payload_too_large", limit: MAX_BODY_BYTES }, 413);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonWithCors({ error: "invalid_json" }, 400);
  }

  // 3) 契约校验（zod）：所有错误带 path，调用方/agent 能定位到具体字段
  const parsed = parseVerifyRequest(raw);
  if (!parsed.ok) {
    return jsonWithCors({ error: "invalid_request", errors: parsed.errors }, 400);
  }
  const { document: submitted, shareId, options } = parsed.value;

  // 4) 按 IP 小时桶限流（VERIFY_HOURLY_LIMIT，默认 120）：公开端点防刷量。
  //    放在校验之后——坏请求不扣额度；也不做失败退还（否则刷子用失败请求绕过计数）。
  const rl = await checkProxyRateLimit(req.headers, "verify", "VERIFY_HOURLY_LIMIT", 120);
  if (!rl.allowed) {
    return jsonWithCors({ error: "rate_limited", limit: rl.limit }, 429);
  }

  // 5) report.checkedAt 与 credential.issuedAt 必须同一个 now：两处时间不一致会
  //    让同一份报告看起来像两次核验；ID 本身不含时间（保证同输入可复算）。
  const now = new Date();

  try {
    if (shareId) {
      // 分享 token → 持久化 Plan → 开放文档（旧 job 链接由 resolvePlan 兜底）
      const plan = await resolvePlan(shareId);
      if (!plan) {
        return jsonWithCors({ error: "not_found" }, 404);
      }
      const doc = planToDocument(plan, { id: shareId });
      return jsonWithCors(reportWithCredential(doc, options, now));
    }

    if (submitted) {
      return jsonWithCors(reportWithCredential(submitted, options, now));
    }

    // parseVerifyRequest 已保证二选一；走到这里说明校验契约变了。
    // 不做非空断言（那会崩成 500），而是明确回 400，便于排障。
    return jsonWithCors(
      {
        error: "invalid_request",
        errors: [{ path: "document", message: "document 与 shareId 必须且只能提供一个" }],
      },
      400,
    );
  } catch (e) {
    // 引擎是纯函数、理论上不该抛；这里兜底成 JSON 错误（而不是 Next 的 HTML 500），
    // 因为本端点的调用方是代码/agent，需要可解析的错误体。
    console.error(`[verify] 核验失败: ${(e as Error)?.message ?? e}`);
    return jsonWithCors({ error: "internal_error" }, 500);
  }
}

/** 报告 + 凭据（同一个 now；凭据口径见 lib/verify/credential.ts） */
function reportWithCredential(doc: TripCheckDocument, options: TripCheckOptions, now: Date) {
  const report = verifyDocument(doc, options, now);
  return { ...report, credential: credentialOf(doc, options, now) };
}
