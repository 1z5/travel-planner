import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthProvider } from "@/lib/auth/providers";
import { consumeWindow } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/code —— 发送验证码
// 防轰炸（真实短信是要钱的）：单手机号 5 条/小时，单 IP 20 条/小时
const BodySchema = z.object({ phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确") });
const PHONE_LIMIT = Number(process.env.SMS_PHONE_LIMIT || 5);
const IP_LIMIT = Number(process.env.SMS_IP_LIMIT || 20);
const HOUR = 3600_000;

export async function POST(req: NextRequest) {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "手机号格式不正确" }, { status: 400 });
  }
  const phone = parsed.data.phone;
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";

  const byPhone = consumeWindow(`code:phone:${phone}`, PHONE_LIMIT, HOUR);
  if (!byPhone.allowed) {
    return NextResponse.json({ error: "验证码发送太频繁，请 1 小时后再试" }, { status: 429 });
  }
  const byIp = consumeWindow(`code:ip:${ip}`, IP_LIMIT, HOUR);
  if (!byIp.allowed) {
    return NextResponse.json({ error: "当前网络发送太频繁，请稍后再试" }, { status: 429 });
  }

  const result = await getAuthProvider().sendCode(phone);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "发送失败，请稍后重试" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
