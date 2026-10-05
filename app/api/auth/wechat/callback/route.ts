import { NextRequest, NextResponse } from "next/server";
import { wechatExchange } from "@/lib/auth/wechat";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";

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
  let redirect = "/";
  try {
    redirect = Buffer.from(redirectB64 ?? "", "base64url").toString() || "/";
  } catch { /* 用默认 */ }
  if (!redirect.startsWith("/")) redirect = "/"; // 防开放重定向

  const { token, maxAgeSec } = createSession(`wx:${openid}`);
  const res = NextResponse.redirect(new URL(redirect, req.nextUrl.origin));
  // 注意：不能混用手动 Set-Cookie 头和 cookies.set（后者会覆盖前者），统一走 cookies API
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSec,
  });
  res.cookies.set("wx_state", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
