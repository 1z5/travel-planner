import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob } from "@/lib/jobs";
import { consume, refund } from "@/lib/ratelimit";
import { readSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 起止时间（本地时间，精确到分钟）：决定行程天数
const DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

// 天数推导：按起止「日历日」含头含尾（10月1日→10月3日 = 3 天；同日 = 1 天）
function deriveDays(startAt: string, endAt: string): number {
  const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
  const e = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

const InputSchema = z.object({
  // 字符白名单：用户输入会拼进 LLM prompt，必须防注入（拒绝特殊字符/超长）
  city: z.string().regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
  startAt: z.string().regex(DT_RE, "起始时间格式不正确"),
  endAt: z.string().regex(DT_RE, "结束时间格式不正确"),
  budget: z.coerce.number().int().min(500).max(200000),
  // 偏好标签同样进 prompt：白名单 + 数量上限
  preferences: z.array(z.string().regex(/^[\u4e00-\u9fa5A-Za-z]{1,10}$/)).max(5).default([]),
  // 住所（选填）：允许数字/书名号/括号（"7天酒店(春熙路店)"）
  hotel: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.string().trim().max(40).regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,40}$/).optional(),
  ),
  // 期望必游地（选填）：最多 5 个，硬约束（validate 会核验是否全部出现）
  mustVisit: z.preprocess(
    (v) => (v === "" || v == null ? [] : v),
    z.array(z.string().trim().max(20).regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,20}$/)).max(5).default([]),
  ),
  // 行程节奏：轻松/适中/紧凑（影响 prompt 密度与体检阈值）
  pace: z.enum(["relaxed", "balanced", "packed"]).default("balanced"),
  // 规划范围：city=单城市（默认）/ region=区域环线（如川西环线、关西）。
  // 区域游天数更长，上限放宽到 10（单城市保持 7）。
  scope: z.enum(["city", "region"]).default("city"),
  // 重点活动（选填，最多 3 个）：用户提供的演唱会/赛事/展览等，需编进行程。
  // 时间可选——给了就围绕它倒推动线，没给则由 AI 建议。名称会拼进 prompt，
  // 因此与 city/hotel 同等防注入（字符白名单 + 长度上限）。
  events: z.preprocess(
    (v) => (v === "" || v == null ? [] : v),
    z.array(
      z.object({
        name: z.string().trim().max(30).regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\s]{2,30}$/),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      }),
    ).max(3).default([]),
  ),
})
  .refine((d) => d.endAt > d.startAt, { message: "结束时间必须晚于开始时间" })
  .refine((d) => deriveDays(d.startAt, d.endAt) <= (d.scope === "region" ? 10 : 7), {
    message: "城市行程支持 1-7 天，区域行程支持 1-10 天；更长的请拆成多段分别规划",
  });

// 配额双轨：登录用户按手机号计数（默认 10 次/天），陌生人按 IP（默认 3 次/天）
function quotaOf(req: NextRequest): { key: string; limit: number; isUser: boolean } {
  const session = readSession(req.headers.get("cookie"));
  if (session) {
    return {
      key: `u:${session.p}`,
      limit: Number(process.env.AUTH_USER_LIMIT || 10),
      isUser: true,
    };
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  return { key: `ip:${ip}`, limit: Number(process.env.DAILY_FREE_LIMIT || 3), isUser: false };
}

export async function POST(req: NextRequest) {
  // 1) 配额（提交即扣，失败归还）
  const q = quotaOf(req);
  const quota = await consume(q.key, q.limit);
  if (!quota.allowed) {
    const msg = q.isUser
      ? `今日免费次数已用完（登录用户每天 ${q.limit} 次）。明天再来。`
      : `今日免费次数已用完（未登录每天 ${q.limit} 次）。登录后可提升到 ${Number(process.env.AUTH_USER_LIMIT || 10)} 次/天。`;
    return NextResponse.json({ error: msg }, { status: 429 });
  }

  // 2) 参数校验
  let input: z.infer<typeof InputSchema>;
  try {
    input = InputSchema.parse(await req.json());
  } catch (e) {
    await refund(q.key);
    const msg =
      e instanceof z.ZodError ? e.issues[0]?.message : null;
    return NextResponse.json(
      { error: msg ?? "参数不完整：需要城市、起止时间、预算（元）" },
      { status: 400 },
    );
  }

  // 3) 创建异步任务（days 由起止时间推导），立即返回
  const job = await createJob({ ...input, days: deriveDays(input.startAt, input.endAt) },
    q.key, q.limit, () => void refund(q.key));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
