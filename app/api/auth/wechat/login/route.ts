import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { wechatLoginUrl } from "@/lib/auth/wechat";
import { cookieSecure } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/wechat/login?redirect=/ —— 跳转微信授权页
// state = <nonce>.<base64url(回调后的落地路径>，同时写 wx_state cookie 防 CSRF
export async function GET(req: NextRequest) {
  if (!process.env.WECHAT_APPID) {
    return NextResponse.json({ error: "微信登录未配置（WECHAT_APPID）" }, { status: 500 });
  }
  const redirect = req.nextUrl.searchParams.get("redirect") || "/";
  const nonce = randomBytes(8).toString("hex");
  const state = `${nonce}.${Buffer.from(redirect).toString("base64url")}`;
  const callbackUrl = `${req.nextUrl.origin}/api/auth/wechat/callback`;

  const res = NextResponse.redirect(wechatLoginUrl(callbackUrl, state));
  res.cookies.set("wx_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 300,
    secure: cookieSecure(),
  });
  return res;
}
