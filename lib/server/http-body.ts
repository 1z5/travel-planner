import "server-only";
import type { NextRequest } from "next/server";

// ============================================================
// 请求体读取与大小上限（server 端统一入口）
//
// 为什么需要：App Router 的 req.json() 没有默认体积上限——公开端点（尤其匿名可写的
// 产品内修复 / 开放核验）被塞一个几百 MB 的 JSON 就能把进程内存打满。JSON 解析前
// 先按 Content-Length 与真实字节数拦一道，错误码语义：
//   - 413 payload_too_large：超限（调用方应停止重试）；
//   - 400 invalid_json / unreadable：格式或传输问题。
//
// 为什么同时看 Content-Length 与真实字节：Content-Length 可缺失/可撒谎（chunked），
// 所以读出来后再量一次；但先看声明值能在读之前就拒绝大多数大包（少分配一次）。
// ============================================================

export type BodyReadResult =
  { ok: true; text: string } | { ok: false; status: 400 | 413; error: string };

/**
 * 读取请求体并限制大小（默认 16 KiB，够 shareId/confirm/options 这类小 JSON）。
 *
 * @param req      请求
 * @param maxBytes 上限（UTF-8 字节数）
 */
export async function readBody(req: NextRequest, maxBytes = 16 * 1024): Promise<BodyReadResult> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: `请求体超过 ${maxBytes} 字节上限` };
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: "请求体不可读" };
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    return { ok: false, status: 413, error: `请求体超过 ${maxBytes} 字节上限` };
  }
  return { ok: true, text };
}

/** 读取并解析 JSON（超限 → 413；非法 JSON → 400 invalid_json） */
export type JsonReadResult =
  { ok: true; json: unknown } | { ok: false; status: 400 | 413; error: string };

export async function readJsonBody(
  req: NextRequest,
  maxBytes = 16 * 1024,
): Promise<JsonReadResult> {
  const body = await readBody(req, maxBytes);
  if (!body.ok) return body;
  try {
    return { ok: true, json: JSON.parse(body.text) };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}
