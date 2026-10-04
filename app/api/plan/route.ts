import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob } from "@/lib/jobs";
import { consume, refund } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InputSchema = z.object({
  city: z.string().min(2, "请填写目的地城市"),
  // v1 上限 4 天：实测 5 天会因输出过长触发空返回/超时（约 16 分钟仍失败）
  days: z.coerce.number().int().min(3).max(4),
  budget: z.coerce.number().int().min(500).max(200000),
  preferences: z.array(z.string()).default([]),
});

export async function POST(req: NextRequest) {
  // 1) 配额（v0：按 IP 计数，提交即扣，失败归还）
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const limit = Number(process.env.DAILY_FREE_LIMIT || 3);
  const quota = consume(ip, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `今日免费次数已用完（每天 ${limit} 次）。明天再来，或微信号获取更多次数。` },
      { status: 429 },
    );
  }

  // 2) 参数校验
  let input: z.infer<typeof InputSchema>;
  try {
    input = InputSchema.parse(await req.json());
  } catch {
    refund(ip, limit);
    return NextResponse.json(
      { error: "参数不完整：需要城市、3-5 天、预算（元）" },
      { status: 400 },
    );
  }

  // 3) 创建异步任务，立即返回
  const job = createJob(input, ip, limit, () => refund(ip, limit));
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
