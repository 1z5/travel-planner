import { NextRequest, NextResponse } from "next/server";
import { clearCookieHeader, readSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/logout —— 清除 session cookie
export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.headers.set("Set-Cookie", clearCookieHeader());
  void readSession(req.headers.get("cookie"));
  return res;
}
