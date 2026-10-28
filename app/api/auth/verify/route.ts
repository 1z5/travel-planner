import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAuthProvider } from "@/lib/auth/providers";
import { createSession, cookieHeader } from "@/lib/auth/session";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { readJsonBody } from "@/lib/http-body";
import { consume, hourKey, peek } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/auth/verify —— 校验验证码，成功则下发 session cookie
//
// 尝试次数上限（安全审计 R9）：验证码 6 位、TTL 5 分钟且失败不计数时，
// 分布式撞码（真实短信 provider）有账号接管面。这里按「手机号 + IP」的小时桶
// 记失败次数：10 次/小时后再试直接 429；**成功不计数**（也不消耗额度）——
// 正常用户不会失败 10 次，被撞码的号码会被锁住一小时（可用重新发码换号码）。
// 为什么复用 consume/hourKey 而不是引入新状态：store 只有配额桶原语、没有
// delete；peek 负责「先挡再来」，失败才 consume，成功后下个小时自然重置。
const BodySchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, "手机号格式不正确"),
  code: z.string().min(4).max(8),
});

/** 同一手机号+IP 每小时允许的失败次数 */
const OTP_FAIL_LIMIT = Number(process.env.OTP_FAIL_HOURLY_LIMIT || 10);

export async function POST(req: NextRequest) {
  // body 上限 16 KiB（安全审计 R1）：phone + code 两个短字段。
  const body = await readJsonBody(req, 16 * 1024);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.status === 413 ? body.error : "参数不完整" },
      { status: body.status },
    );
  }
  const parsed = BodySchema.safeParse(body.json);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不完整" }, { status: 400 });
  }
  const { phone, code } = parsed.data;

  // 撞码防护：先用 peek 看是否已被锁（不消耗），超限直接 429。
  // peek 返回剩余次数（不是 {allowed}），<=0 即已用完。
  const ip = clientIpFromHeaders(req.headers);
  const failKey = hourKey("otp-fail", `${phone}:${ip}`);
  const remainingAttempts = await peek(failKey, OTP_FAIL_LIMIT);
  if (remainingAttempts <= 0) {
    return NextResponse.json({ error: "验证码尝试次数过多，请 1 小时后再试" }, { status: 429 });
  }

  const ok = await getAuthProvider().verifyCode(phone, code);
  if (!ok) {
    // 只在失败时计数（成功路径不消费额度）
    await consume(failKey, OTP_FAIL_LIMIT);
    return NextResponse.json({ error: "验证码错误或已过期" }, { status: 401 });
  }
  const { token, maxAgeSec } = createSession(phone);
  const res = NextResponse.json({ ok: true, phone });
  res.headers.set("Set-Cookie", cookieHeader(token, maxAgeSec));
  return res;
}
