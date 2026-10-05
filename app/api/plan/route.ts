import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob } from "@/lib/jobs";
import { consume, refund } from "@/lib/ratelimit";
import { readSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InputSchema = z.object({
  // 字符白名单：用户输入会拼进 LLM prompt，必须防注入（拒绝特殊字符/超长）
  city: z.string().regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
  // v1 上限 4 天：实测 5 天会因输出过长触发空返回/超时（约 16 分钟仍失败）
  days: z.coerce.number().int().min(3).max(4),
  budget: z.coerce.number().int().min(500).max(200000),
  // 偏好标签同样进 prompt：白名单 + 数量上限
  preferences: z.array(z.string().regex(/^[\u4e00-\u9fa5A-Za-z]{1,10}$/)).max(5).default([]),
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
  const quota = consume(q.key, q.limit);
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
  } catch {
    refund(q.key, q.limit);
    return NextResponse.json(
      { error: "参数不完整：需要城市（中文/字母）、3-4 天、预算（元）、偏好不超过 5 个" },
      { status: 400 },
    );
  }

  // 3) 创建异步任务，立即返回
  const job = createJob(input, q.key, q.limit, () => refund(q.key, q.limit));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
