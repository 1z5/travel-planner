import { NextRequest, NextResponse } from "next/server";
import { wechatExchange } from "@/lib/auth/wechat";
import { createSession, cookieSecure, SESSION_COOKIE } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/wechat/callback?code=&state= —— 微信回调
// 校验 state 与 cookie 一致 → code 换 openid → 签发 session → 跳回落地页
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("wx_state")?.value;

  if (!code || !state || state !== cookieState) {
    return NextResponse.json({ error: "登录状态无效，请重新发起微信登录" }, { status: 400 });
  }

  let openid: string;
  try {
    openid = await wechatExchange(code);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "微信授权失败" },
      { status: 500 },
    );
  }

  const [, redirectB64] = state.split(".");
  const redirect = safeRedirectPath(redirectB64, req.nextUrl.origin);

  const { token, maxAgeSec } = createSession(`wx:${openid}`);
  const res = NextResponse.redirect(new URL(redirect, req.nextUrl.origin));
  // 注意：不能混用手动 Set-Cookie 头和 cookies.set（后者会覆盖前者），统一走 cookies API
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSec,
    secure: cookieSecure(),
  });
  res.cookies.set("wx_state", "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: cookieSecure(),
  });
  return res;
}

/**
 * 把 state 里携带的落地路径校验成**本站相对路径**（安全审计 R10 开放重定向）。
 *
 * 为什么不能只用 `redirect.startsWith("/")`：`//evil.com` 与 `/\evil.com` 都能
 * 通过前缀检查，而浏览器把 `new URL("//evil.com", origin)` 解析成外站——
 * 攻击者构造一条微信登录链接就能在 OAuth 成功后把用户带去钓鱼站。
 *
 * 口径（两道）：
 * 1. 归一化反斜杠（浏览器在 URL 里把 `\` 当 `/`），然后必须是「单个 / 开头的
 *    路径」——`//host` 与 `/\host` 都被挡回 "/"；
 * 2. 再用 URL 解析一次，origin 必须与本站一致（防编码/协议相对等变体）；
 * 通过后只返回 pathname+search+hash（绝对同源 URL 也降级成路径）。
 * 任何异常一律回 "/"（fail-closed，绝不跳到未知目标）。
 */
function safeRedirectPath(redirectB64: string | undefined, origin: string): string {
  let raw = "/";
  try {
    raw = Buffer.from(redirectB64 ?? "", "base64url").toString("utf8") || "/";
  } catch {
    return "/";
  }
  const normalized = raw.replace(/\\/g, "/");
  if (!normalized.startsWith("/") || normalized.startsWith("//")) return "/";
  try {
    const target = new URL(normalized, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}
