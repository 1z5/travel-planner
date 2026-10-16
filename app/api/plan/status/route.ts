import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { peek } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/status?id=job_xxx
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "任务不存在或已过期，请重新生成" }, { status: 404 });
  }
  // 剩余次数实时计算：失败退还后立刻反映，不做快照
  const remaining = await peek(job.key, job.limit);
  if (job.status === "done") {
    return NextResponse.json({ status: "done", plan: job.plan, remaining });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error, remaining });
  }
  // running：分日流式路径会增量写入 job.plan（已生成的天 + 骨架）。
  // 带出去前端就能渐进渲染，不必等全量生成完。
  // daysReady/daysTotal 让前端能显示「已生成 N/M 天」。
  const daysReady = job.plan?.days.length ?? 0;
  return NextResponse.json({
    status: "running",
    elapsedMs: Date.now() - job.createdAt,
    plan: job.plan,
    daysReady,
  });
}
