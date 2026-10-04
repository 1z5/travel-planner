import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { peek } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/status?id=job_xxx
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const job = getJob(id);
  if (!job) {
    return NextResponse.json({ error: "任务不存在或已过期，请重新生成" }, { status: 404 });
  }
  // 剩余次数实时计算：失败退还后立刻反映，不做快照
  const remaining = peek(job.ip, job.limit);
  if (job.status === "done") {
    return NextResponse.json({ status: "done", plan: job.plan, remaining });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error, remaining });
  }
  return NextResponse.json({ status: "running", elapsedMs: Date.now() - job.createdAt });
}
