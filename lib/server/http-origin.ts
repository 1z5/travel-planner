import "server-only";
import type { NextRequest } from "next/server";

// ============================================================
// 浏览器跨站请求防护（CSRF 的纵深防御，不是唯一防线）
//
// 认证模型：匿名用户用「分享 token 即凭据」（token 在 URL/请求体里，攻击者拿不到就
// 改不了）；登录用户用 HttpOnly + SameSite 的 session cookie。对 cookie 认证的写端点，
// 跨站表单/脚本如果能让浏览器自动带 cookie，就有 CSRF 面。
//
// 本函数的约定（保守且对非浏览器客户端友好）：
// - **没有 Origin 头** → 放行（curl/agent/服务端调用；它们不会自动带 cookie）；
// - **有 Origin** → 必须与请求的 Host 同源；否则拒绝；
// - 同时参考 Sec-Fetch-Site：明确 cross-site 也拒绝（现代浏览器都有）。
//
// 注意：这不是「同源策略」的替代（浏览器已按 CORS 拦 JSON 跨域请求），而是给
// 「同源但来自第三方 iframe/被注入脚本」与未来 CORS 放宽时留的一层确定性收口。
// ============================================================

/** 请求是否来自同源浏览器（无 Origin 视为非浏览器客户端，放行） */
export function isSameOriginRequest(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site === "cross-site") return false;

  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const host = req.headers.get("host");
    if (!host) return false;
    // 只比 host（含端口）：Render/反代下协议到应用层已终止，scheme 可能不一致。
    return parsed.host === host;
  } catch {
    return false;
  }
}

/**
 * 写操作前的统一校验结果：null = 放行；否则返回应直接回给调用方的 403 文案。
 */
export function crossSiteWriteError(req: NextRequest): string | null {
  return isSameOriginRequest(req) ? null : "跨站请求被拒绝：写操作只接受同源浏览器请求";
}
