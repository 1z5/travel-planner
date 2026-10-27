import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPlanForEdit, replacePlan } from "@/lib/plan-repo";
import { validateRestorePlan } from "@/lib/plan-restore";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getStore } from "@/lib/store";
import { newEventId } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/restore —— 撤销这次修改（回到上一版）
//
// 为什么需要：修改可能把行程改坏（换的点通勤更远、顺延后反而更紧），用户需要
// 一个「退回去」的确定性动作，而不是再赌一次 AI。前端把「修改前那一版 plan」
// （本来就从服务端拿到的）发回来，服务端校验后落库为**新版本**（revision+1）——
// 不做版本指针回滚：分享页面看到的就是当前这一版，语义简单且不丢历史。
//
// 认证模型：分享 token 即凭据（与 refine/调整一致：拿到链接的人可以一起编）。
// 为什么校验而不是直接信：存储里可能被写入任意 JSON，先挡畸形/超大 payload；
// 同时保留 verified/verification/warnings/legs 等富字段（见 lib/plan-restore.ts）。
//
// 配额：不占生成配额（这不是重新生成）；按 IP 小时桶限流，防被当作免费写接口刷。
// ============================================================

function restoreHourlyLimit(): number {
  return Number(process.env.RESTORE_HOURLY_LIMIT || 60);
}

const BodySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
  // plan 先收 unknown，再用 lib/plan-restore 的专用校验器（保留富字段）
  plan: z.unknown(),
});

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式不正确，需要 JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const { shareId } = parsed.data;

  const validated = validateRestorePlan(parsed.data.plan);
  if (!validated.ok) {
    return NextResponse.json({ error: `撤销失败：${validated.error}` }, { status: 400 });
  }

  // 先确认目标存在再计数，避免拿不存在的 id 白耗小时额度
  const existing = await getPlanForEdit(shareId);
  if (!existing) {
    return NextResponse.json(
      { error: "这份行程不存在或已被删除（旧的任务链接不支持撤销，请重新生成后编辑）" },
      { status: 404 },
    );
  }

  const limit = restoreHourlyLimit();
  const winKey = hourKey("restore", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `撤销太频繁：每小时最多 ${limit} 次，请稍后再试` },
      { status: 429 },
    );
  }

  const record = await replacePlan(shareId, validated.plan);
  if (!record) {
    await refund(winKey);
    return NextResponse.json({ error: "这份行程不存在或已被删除" }, { status: 404 });
  }

  // 埋点：撤销频次是「修改体验」的负向信号（频繁撤销 = 改动质量差，值得优化）
  try {
    await getStore().events.record({
      id: newEventId(),
      name: "plan_restored",
      shareId,
      city: record.plan.city,
      createdAt: Date.now(),
    });
  } catch {
    /* 埋点失败不阻塞撤销 */
  }

  console.log(`[restore] ${shareId} → 第 ${record.revision} 版（回到修改前）`);
  return NextResponse.json({ plan: record.plan, revision: record.revision });
}
