import { NextRequest, NextResponse } from "next/server";
import { getJob, getJobStage, interruptJob, isJobStale, JOB_INTERRUPTED_ERROR } from "@/lib/jobs";
import { peek } from "@/lib/ratelimit";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/status?id=job_xxx
//
// 限流（安全审计 R3）：jobId 是读任务结果的唯一凭据，旧链接还能经 resolvePlan
// 读回行程。jobId 已改为 CSPRNG（见 lib/jobs.ts newJobId），这里再加一层按 IP
// 小时桶（默认 3600/小时）——正常前端 3s 轮询远到不了，但把「换 id 批量试探」
// 的成本从零提到可观测。额度给的宽是因为轮询是产品主链路，不能误伤。
export async function GET(req: NextRequest) {
  const rl = await checkProxyRateLimit(
    req.headers,
    "plan-status",
    "PLAN_STATUS_HOURLY_LIMIT",
    20000,
  );
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `查询太频繁：每小时最多 ${rl.limit} 次，请稍后再试`, limit: rl.limit },
      { status: 429 },
    );
  }

  const id = req.nextUrl.searchParams.get("id") ?? "";
  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: "任务不存在或已过期，请重新生成" }, { status: 404 });
  }

  // 陈旧任务自愈（本轮新增）：服务重启/进程冻结会让 running 任务永远停在
  // running，前端按 3s 轮询白等 15 分钟才发现没结果。用「最后一次心跳」判定
  // 任务是否还活着：超时即置 error 并退还配额，让用户立刻重新生成。
  // 判定放在计算 remaining 之前——中断会退配额，remaining 必须是退款后的值。
  if (isJobStale(job)) {
    await interruptJob(job);
    const remaining = await peek(job.key, job.limit);
    return NextResponse.json({ status: "error", error: JOB_INTERRUPTED_ERROR, remaining });
  }

  // 剩余次数实时计算：失败退还后立刻反映，不做快照
  const remaining = await peek(job.key, job.limit);
  if (job.status === "done") {
    return NextResponse.json({
      status: "done",
      plan: job.plan,
      remaining,
      // 持久化失败时为 null：前端据此隐藏分享/日历入口（诚实降级，不给打不开的链接）
      shareId: job.shareId ?? null,
    });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error, remaining });
  }
  // running：分日流式路径会增量写入 job.plan（已生成的天 + 骨架）。
  // 带出去前端就能渐进渲染，不必等全量生成完。
  // daysReady/daysTotal 让前端能显示「已生成 N/M 天」。
  const daysReady = job.plan?.days.length ?? 0;
  // 阶段遥测（增量字段）：管线真实位置（见 lib/jobs.ts JobStage），前端据此
  // 渲染「看着行程长出来」的阶段清单。旧任务（升级前创建）或遥测缺失时
  // 这个键不出现——JSON 里没有 stage，前端降级为不确定进度条，不猜进度。
  const stage = getJobStage(id);
  return NextResponse.json({
    status: "running",
    elapsedMs: Date.now() - job.createdAt,
    plan: job.plan,
    daysReady,
    ...(stage ? { stage } : {}),
  });
}
