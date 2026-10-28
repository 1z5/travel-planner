import { NextRequest, NextResponse } from "next/server";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";
import { resolvePlan } from "@/lib/plan-repo";
import { JSON_RPC_ERRORS, handleMcpMessage } from "@/lib/verify/mcp";
import { TRIP_CHECK_SPEC_VERSION } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/mcp —— Trip Check 的 MCP 端点（JSON-RPC 2.0 · 无状态单消息）
//
// 为什么是无状态：MCP 的 Streamable HTTP 传输允许服务端只实现「POST JSON-RPC」，
// 不建 session、不开 SSE。本服务只有确定性只读工具（没有进度通知、没有采样、
// 没有服务端主动消息），所以 SSE 与 Mcp-Session-Id 都是纯多余状态——不做。
// 显式 GET → 405（而不是让 Next 回 HTML 405），并在 body 里说明原因，客户端
// 一眼知道是「实现范围」而不是「网络坏了」。
//
// 为什么 CORS 全开：和 /api/verify 同一个理由——MCP 客户端可能是浏览器里的
// agent playground；分享 token 不可猜测、工具只读，跨域读不到别人的行程。
// 注意：端点无鉴权、无限流（见 mcp/README.md「诚实边界」），不要直接挂公网。
//
// 为什么 body 上限 256 KiB：与 /api/verify 同口径（30 天 × 40 点位的文档远小于
// 此值）。超限在解析前按 413 拒，避免公开端点被超大 JSON 拖死解析器。
// ============================================================

/** 请求体上限：与 /api/verify 一致（开放文档的合理规模远小于此） */
const MAX_BODY_BYTES = 256 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  // MCP 客户端会带 Accept；初始化后会带 Mcp-Protocol-Version（我们不做 session）
  "Access-Control-Allow-Headers": "Content-Type,Accept,Mcp-Protocol-Version",
  "Access-Control-Expose-Headers": "X-Trip-Check-Spec",
  "X-Trip-Check-Spec": TRIP_CHECK_SPEC_VERSION,
} as const;

/** JSON-RPC 错误响应（传输层错误用；正常消息的错误体由 mcp.ts 生成） */
function rpcErrorResponse(status: number, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: CORS_HEADERS },
  );
}

/** GET /api/mcp —— 不提供 SSE 流：明确 405 + 可读原因（Streamable HTTP 允许只支持 POST） */
export async function GET() {
  return NextResponse.json(
    {
      error: "method_not_allowed",
      detail:
        "本端点是无状态 JSON-RPC 端点（MCP Streamable HTTP 下仅实现 POST，不实现 GET/SSE 服务端推送与 session）。请用 POST 发送单条 JSON-RPC 消息。",
    },
    { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } },
  );
}

/** OPTIONS /api/mcp —— CORS 预检（204 不能带 body） */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  // 0) 按 IP 小时桶限流：这是公开部署的无鉴权端点（MCP 客户端不保证带 cookie），
  //    没有限流时一个脚本就能把进程 CPU 打满（repair 工具会做完整判定）。
  //    放在读 body 之前：避免为高频垃圾请求反复分配大字符串。
  const rl = await checkProxyRateLimit(req.headers, "mcp", "MCP_HOURLY_LIMIT", 120);
  if (!rl.allowed) {
    return rpcErrorResponse(
      429,
      JSON_RPC_ERRORS.invalidRequest,
      `请求过于频繁：每小时最多 ${rl.limit} 次，请稍后再试`,
    );
  }

  // 1) 读原文再交给 mcp.ts：由它负责 JSON.parse（才能给出 -32700 的语义），
  //    也保证 route 不重复实现协议解包。
  let text: string;
  try {
    text = await req.text();
  } catch {
    return rpcErrorResponse(400, JSON_RPC_ERRORS.parse, "Parse error：请求体不可读");
  }

  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return rpcErrorResponse(
      413,
      JSON_RPC_ERRORS.invalidRequest,
      `请求体超过 ${MAX_BODY_BYTES} 字节上限`,
    );
  }

  // 2) resolvePlan 注入：mcp.ts 不 import server-only 的 plan-repo（可单测），
  //    这是「读分享行程」的唯一副作用入口；工具本身只读、不落库。
  const result = await handleMcpMessage(text, { resolveShare: resolvePlan });

  // 3) 通知（无 id）回 202 空 body：new NextResponse(null) 不能换成 .json(undefined)
  //    （后者会写出 "undefined" 文本或抛错）。
  if (result.body === undefined) {
    return new NextResponse(null, { status: result.status, headers: CORS_HEADERS });
  }
  return NextResponse.json(result.body, { status: result.status, headers: CORS_HEADERS });
}
