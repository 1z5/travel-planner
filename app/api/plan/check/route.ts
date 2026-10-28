import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/http-body";
import { getPlanForEdit, resolvePlan } from "@/lib/plan-repo";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";
import type { Plan } from "@/lib/types";
import { planToDocument } from "@/lib/verify/adapt";
import { credentialOf } from "@/lib/verify/credential";
import { verifyDocument } from "@/lib/verify/engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/check —— 产品内行程体检（Trip Check 核验层的产品入口）
//
// 与开放端点 POST /api/verify 的关系（两者刻意分开）：
// - /api/verify 是**无状态**开放判定：不认站内身份、不写库，任何人可对任意文档体检；
// - /api/plan/check 是**站内**入口：用分享 token 认行程，额外返回 `planRevision`
//   （版本号，修复/撤销的并发基准）与 `tripCheck`（该行程最近一次修复的凭据链）。
//   判定仍是同一个 planToDocument → verifyDocument → credentialOf，口径不分叉。
//
// 认证模型与 refine/restore 一致：**分享 token 即凭据**（拿到链接的人可以一起编）。
// 因此本端点只按 IP 小时桶限流（PLAN_CHECK_HOURLY_LIMIT，默认 120），不做登录门槛。
//
// 为什么旧 job 链接也允许 check：只读体检不会改任何东西，历史链接能体检是好事；
// 但它没有 revision（job 不是 Plan），所以 planRevision 返回 null，调用方据此禁用
// 「修复写回」（/api/plan/repair 会 404，旧链接只读）。
// ============================================================

const BodySchema = z.object({
  // 分享 token 与 job id 都是 URL-safe（job id 形如 job_xxx），同一个入口兼容
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "行程链接格式不正确"),
});

export async function POST(req: NextRequest) {
  // 1) 参数校验（放在限流之前：畸形请求不该消耗用户的小时额度）。
  //    先用 readJsonBody 兜住体积（16 KiB 足够 shareId；App Router 的 req.json()
  //    本身没有上限，公开端点被塞大包会直接吃内存）。
  const body = await readJsonBody(req, 16 * 1024);
  if (!body.ok) {
    return NextResponse.json(
      { error: body.status === 413 ? body.error : "请求格式不正确，需要 JSON body" },
      { status: body.status },
    );
  }
  const parsed = BodySchema.safeParse(body.json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const { shareId } = parsed.data;

  try {
    // 2) 持久化 Plan 优先（有 revision）；旧 job 链接走 resolvePlan 只读兜底
    const record = await getPlanForEdit(shareId);
    const plan: Plan | null = record ? record.plan : await resolvePlan(shareId);
    if (!plan) {
      return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
    }

    // 3) 限流（确认行程存在之后：不存在的 id 不该白耗额度）
    const rl = await checkProxyRateLimit(req.headers, "plan-check", "PLAN_CHECK_HOURLY_LIMIT", 120);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `核验太频繁：每小时最多 ${rl.limit} 次，请稍后再试`, limit: rl.limit },
        { status: 429 },
      );
    }

    // 4) 同一个 now：report.checkedAt 与 credential.issuedAt 必须一致
    //    （时间只影响展示字段，不参与判定/凭据 ID，所以重复检视 ID 不变）
    const now = new Date();
    const document = planToDocument(plan, { id: shareId });
    const report = verifyDocument(document, {}, now);
    const credential = credentialOf(document, {}, now);

    return NextResponse.json({
      shareId,
      // 修复/撤销的并发基准：持久化行程有版本号，旧 job 链接没有（null）
      planRevision: record ? record.revision : null,
      report,
      credential,
      // 该行程已有过的修复历史（凭据链/次数）；没修过就是 null，不编造
      tripCheck: plan.tripCheck ?? null,
    });
  } catch (e) {
    // 存储/引擎异常：返回可解析的 JSON 错误（调用方是前端与 agent，不该收到 HTML 500）
    console.error(`[plan-check] ${shareId} 核验失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "核验失败：服务暂时不可用，请稍后重试" }, { status: 500 });
  }
}
