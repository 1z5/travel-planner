import { NextRequest, NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";
import { buildIcs } from "@/lib/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/ics?id=job_xxx —— 行程日历订阅文件（与分享页同源，只读）
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const job = getJob(id);
  if (!job || job.status !== "done" || !job.plan) {
    return NextResponse.json({ error: "任务不存在或已过期" }, { status: 404 });
  }
  const ics = buildIcs(job.plan);
  const filename = encodeURIComponent(`${job.plan.city}${job.plan.days.length}天行程.ics`);
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
    },
  });
}
