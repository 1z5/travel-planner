import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { answerCopilot, CopilotError } from "@/lib/copilot";
import { getPlanForEdit, resolvePlan } from "@/lib/plan-repo";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { tryAcquireSlot, tryReserveLlmBudget } from "@/lib/capacity-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/chat —— 行程管家（Copilot）问答
//
// 认证模型与 refine/adjust 一致：分享 token 即凭据（拿到链接的人可以一起问）。
// 只读：只回答行程问题、给一个可执行建议，**不写库**；真正修改仍走 /refine
// 或 /adjust（前端点建议后带 fixKind/day 调用）。
//
// 与生成/修改配额的关系：问答走独立的按 IP 小时桶（COPILOT_HOURLY_LIMIT，
// 默认 40），不占每日生成配额，也不与 refine 的 20 次/小时互相挤占。
//
// 旧链接兼容：resolvePlan 能读旧 job 链接的 plan，但 getPlanForEdit 只有持久
// Plan 有 input。旧链接仍然能回答（少输入约束），只是 system prompt 里会明确
// 告诉模型「预算/必游地/住所未知，不要猜」。
// ============================================================

/** 问答每小时每 IP 上限。问答比改行程轻，但仍调 LLM，默认比 refine 宽 */
function copilotHourlyLimit(): number {
  const raw = Number(process.env.COPILOT_HOURLY_LIMIT || 40);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 40;
}

// IP 由 lib/client-ip 统一提取（不再取 XFF 首值：客户端可伪造，见审计 P0-3）
function clientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers);
}

const MessageSchema = z.strictObject({
  role: z.enum(["user", "assistant"], { message: "role 只能是 user 或 assistant" }),
  content: z.string().trim().min(1, "消息内容不能为空").max(500, "单条消息最多 500 字"),
});

const BodySchema = z
  .strictObject({
    // 与 refine/adjust 同一条 share token 规则
    shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
    messages: z.array(MessageSchema).min(1, "至少需要 1 条消息").max(12, "消息最多 12 条"),
  })
  .refine((d) => d.messages[d.messages.length - 1]?.role === "user", {
    message: "最后一条消息必须是你的提问（role=user）",
    path: ["messages"],
  });

// 全局限流（审计 P0-3）：聊天每次都是一次 LLM 调用，单 IP 小时桶防不住伪造
// IP 或真实爆量。这里再加一层进程内并发闸门（见 lib/capacity-gate.ts）。
export async function POST(req: NextRequest) {
  const release = tryAcquireSlot("llm");
  if (!release) {
    return NextResponse.json({ error: "当前请求较多，请稍后再试" }, { status: 503 });
  }
  try {
    return await handlePost(req);
  } finally {
    release();
  }
}

async function handlePost(req: NextRequest) {
  // 1) 参数校验（放在限流之前：畸形请求不该消耗用户的小时额度）
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
  const { shareId, messages } = parsed.data;

  // 2) 行程必须存在（分享页/ics/refine 同一入口：新 Plan + 旧 job 兜底）
  const plan = await resolvePlan(shareId);
  if (!plan) {
    return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
  }
  // 旧 job 链接没有 input：仍可回答，但 system prompt 会明确标注约束未知
  const record = await getPlanForEdit(shareId);
  const input = record?.input ?? null;

  // 3) 限流（确认请求有效之后、调模型之前）
  const limit = copilotHourlyLimit();
  const winKey = hourKey("copilot", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `行程管家每小时 ${limit} 次，已用完，请稍后再试` },
      { status: 429 },
    );
  }

  // 全站 LLM 日预算（审计 P0-3）：与 refine 同口径，防公开演示站被刷。
  if (!tryReserveLlmBudget()) {
    await refund(winKey);
    return NextResponse.json({ error: "今日服务调用额度已用完，请明天再试" }, { status: 429 });
  }

  // 4) 调模型。失败退还名额：一次失败不该吃掉用户这一次提问机会
  const t0 = Date.now();
  try {
    const result = await answerCopilot(plan, input, messages);
    const suggestionLog = result.suggestion
      ? `${result.suggestion.kind === "fix" ? result.suggestion.fixKind : "retime"}@${result.suggestion.day}`
      : "none";
    console.log(
      `[copilot] share ${shareId} 用时 ${Date.now() - t0}ms suggestion=${suggestionLog} tokens=${result.usage ?? "?"}`,
    );
    return NextResponse.json({
      answer: result.answer,
      ...(result.suggestion ? { suggestion: result.suggestion } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
  } catch (e) {
    await refund(winKey);
    if (e instanceof CopilotError) {
      return NextResponse.json({ error: `行程管家暂时无法回答：${e.message}` }, { status: 502 });
    }
    // 未知异常：不透出内部细节，只给可行动信息
    console.error(`[copilot] share ${shareId} 未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "行程管家暂时无法回答，请稍后重试" }, { status: 502 });
  }
}
