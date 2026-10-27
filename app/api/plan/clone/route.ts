import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob } from "@/lib/jobs";
import { consume, refund } from "@/lib/ratelimit";
import { readSession } from "@/lib/auth/session";
import { getPlanForEdit, resolvePlan } from "@/lib/plan-repo";
import { deriveCloneInput, CloneOverridesSchema } from "@/lib/plan-clone";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getStore } from "@/lib/store";
import { newEventId } from "@/lib/metrics";
import {
  releaseGenerationBudget,
  tryAcquireSlot,
  tryReserveGenerationBudget,
} from "@/lib/capacity-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/clone —— 一键克隆：分享页「把这趟行程改成我的日期」。
//
// 与 /api/plan 的关系：**同一条生成管线**。克隆不是复制 JSON 改日期——
// 它推导出一份新的 PlanInput（继承原行程的城市/偏好/约束，覆盖用户的
// 时间/预算/节奏），然后照常创建异步任务，事实层会对**新日期**重新核验
// 闭馆日与通勤。这就是「克隆」相对竞品（改个日期的复印件）的分水岭。
//
// 配额口径与 /api/plan 完全一致：克隆 = 一次生成，提交即扣、失败退还。
// 否则「分享页一键克隆」会变成一条绕过每日免费次数的暗道。
// ============================================================

// 为什么复制 quotaOf 而不 import：app/api/plan/route.ts 没有导出它，
// 且路由之间互相 import 会把 Next 模块边界搅浑。口径必须与那边一致
// （登录按手机号 / 未登录按 IP）。
function quotaOf(req: NextRequest): { key: string; limit: number; isUser: boolean } {
  const session = readSession(req.headers.get("cookie"));
  if (session) {
    return {
      key: `u:${session.p}`,
      limit: Number(process.env.AUTH_USER_LIMIT || 10),
      isUser: true,
    };
  }
  // IP 由 lib/client-ip 统一提取（不再取 XFF 首值：客户端可伪造，见审计 P0-3）
  const ip = clientIpFromHeaders(req.headers);
  return { key: `ip:${ip}`, limit: Number(process.env.DAILY_FREE_LIMIT || 3), isUser: false };
}

const BodySchema = z.object({
  // shareId 形状先挡一层（与 adjust 路由同口径）：明显畸形的 id 不值得
  // 走到配额与查库那几步。
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "行程链接格式不正确"),
  overrides: CloneOverridesSchema.optional(),
});

export async function POST(req: NextRequest) {
  // 1) 配额（提交即扣，任何后续失败都归还——与 /api/plan 同口径）
  const q = quotaOf(req);
  const quota = await consume(q.key, q.limit);
  if (!quota.allowed) {
    const msg = q.isUser
      ? `今日免费次数已用完（登录用户每天 ${q.limit} 次）。明天再来。`
      : `今日免费次数已用完（未登录每天 ${q.limit} 次）。登录后可提升到 ${Number(process.env.AUTH_USER_LIMIT || 10)} 次/天。`;
    return NextResponse.json({ error: msg }, { status: 429 });
  }

  // 2) 参数校验
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    await refund(q.key);
    return NextResponse.json({ error: "请求格式不正确，需要 JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    await refund(q.key);
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不完整：需要行程链接 shareId" },
      { status: 400 },
    );
  }
  const { shareId, overrides } = parsed.data;

  // 3) 读原始行程。只认持久化 Plan（getPlanForEdit）：
  //    旧 job 链接是只读的历史结果（没有 input/owner 语义，2 小时后还会被
  //    清理），对它「克隆」只能复制一份没有事实依据的 JSON——这正是红线
  //    禁止的假克隆，所以明确拒绝而不是将就。
  const record = await getPlanForEdit(shareId);
  if (!record) {
    await refund(q.key);
    if (await resolvePlan(shareId)) {
      return NextResponse.json(
        {
          error: "这条是旧版分享链接，只读、不支持克隆；请让分享者重新生成后把新链接发给你",
        },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: "行程不存在或已被删除，无法克隆" }, { status: 404 });
  }

  // 4) 推导克隆输入（继承 + 覆盖 + 全量校验）。原行程输入本身不合格
  //    （脏数据/历史版本）时如实报错，不硬着头皮把脏字段拼进 prompt。
  const derived = deriveCloneInput(record, overrides);
  if (!derived.ok) {
    await refund(q.key);
    return NextResponse.json({ error: derived.error }, { status: 400 });
  }

  // 5) 服务端容量闸门（与 /api/plan 同口径，见审计 P0-3）：克隆 = 一次完整生成，
  //    不能成为绕过全局限并发/日预算的暗道。满了退还本次额度。
  const releaseSlot = tryAcquireSlot("generate");
  if (!releaseSlot) {
    await refund(q.key);
    return NextResponse.json(
      { error: "当前生成任务较多，请稍后再试（本次未消耗额度）" },
      { status: 503 },
    );
  }
  if (!tryReserveGenerationBudget()) {
    releaseSlot();
    await refund(q.key);
    return NextResponse.json(
      { error: "今日服务生成容量已满，请明天再试（本次未消耗额度）" },
      { status: 429 },
    );
  }

  // 6) 创建异步任务（与 /api/plan 相同签名）：完整生成管线，含事实层对
  //    新日期重新核验。立即返回 jobId，前端轮询 /api/plan/status。
  let job;
  try {
    job = await createJob(
      derived.input,
      q.key,
      q.limit,
      () => void refund(q.key), // 生成失败归还配额（与 /api/plan 一致）
      () => releaseSlot(), // 任务终态：释放全局并发槽
    );
  } catch (e) {
    releaseGenerationBudget();
    releaseSlot();
    await refund(q.key);
    throw e;
  }
  console.log(
    `[clone] ${shareId} → 新任务 ${job.id}（${derived.input.city} ${derived.input.days} 天 ${derived.input.startAt}~${derived.input.endAt}）`,
  );
  // 埋点：trip_cloned 之前在 EVENT_NAMES 里声明但没有任何地方写——分享裂变
  // 的转化率因此不可计算。提交即记（与漏斗口径一致：用户点了克隆）。
  // 写入失败不影响主流程（EventStore.record 本身也不抛）。
  try {
    await getStore().events.record({
      id: newEventId(),
      name: "trip_cloned",
      shareId,
      city: derived.input.city,
      createdAt: Date.now(),
    });
  } catch {
    /* 埋点失败不阻塞克隆 */
  }
  return NextResponse.json({ jobId: job.id }, { status: 202 });
}
