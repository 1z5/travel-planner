import { NextRequest, NextResponse } from "next/server";
import { readSession } from "@/lib/auth/session";
import { peek, userLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/me —— 当前登录态与剩余次数
export async function GET(req: NextRequest) {
  const session = readSession(req.headers.get("cookie"));
  const provider = process.env.AUTH_PROVIDER || "none";
  if (!session) {
    return NextResponse.json({ loggedIn: false, remaining: null, provider });
  }
  return NextResponse.json({
    loggedIn: true,
    phone: session.p,
    provider,
    // 登录用户按用户计数（10 次/天）
    remaining: peek(`u:${session.p}`, userLimit()),
  });
}
