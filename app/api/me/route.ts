import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/auth/session";
import { isProductionAuthMisconfigured, resolveAuthProviderId } from "@/lib/auth/guards";
import { peek, userLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/me —— 当前登录态与剩余次数
export async function GET(req: NextRequest) {
  const session = readSession(req.headers.get("cookie"));
  // 生产误配时登录整体关闭（DisabledProvider）：对外如实报 disabled，
  // 不要回显 env 原值让前端以为还能用「开发登录」。
  const provider = isProductionAuthMisconfigured() ? "disabled" : resolveAuthProviderId();
  if (!session) {
    return NextResponse.json({ loggedIn: false, remaining: null, provider });
  }
  return NextResponse.json({
    loggedIn: true,
    phone: session.p,
    provider,
    // 登录用户按用户计数（10 次/天）
    remaining: await peek(`u:${session.p}`, userLimit()),
  });
}
