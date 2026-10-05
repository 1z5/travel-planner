import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthProvider } from "@/lib/auth/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/code —— 发送验证码
const BodySchema = z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确") });

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
  }
  const result = await getAuthProvider().sendCode(parsed.data.phone);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "发送失败，请稍后重试" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
