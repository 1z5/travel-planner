import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthProvider } from "@/lib/auth/providers";
import { createSession, cookieHeader } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/verify —— 校验验证码，成功则下发 session cookie
const BodySchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
  code: z.string().min(4).max(8),
});

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }
  const ok = await getAuthProvider().verifyCode(parsed.data.phone, parsed.data.code);
  if (!ok) {
    return NextResponse.json({ error: "验证码错误或已过期" }, { status: 401 });
  }
  const { token, maxAgeSec } = createSession(parsed.data.phone);
  const res = NextResponse.json({ ok: true, phone: parsed.data.phone });
  res.headers.set("Set-Cookie", cookieHeader(token, maxAgeSec));
  return res;
}
