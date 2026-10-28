import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { demoWriteBlockedMessage } from "@/lib/demo-seed";
import { readJsonBody } from "@/lib/http-body";
import { crossSiteWriteError } from "@/lib/http-origin";
import { getPlanForEdit, replacePlan } from "@/lib/plan-repo";
import { MAX_RESTORE_BYTES, validateRestorePlan } from "@/lib/plan-restore";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getStore } from "@/lib/store";
import { newEventId } from "@/lib/metrics";
import { refreshTimeWarnings } from "@/lib/validate";
import type { Plan } from "@/lib/types";

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
//
// **信任边界（安全审计 R5，重要）**：客户端回传的 plan 是「副本」，不是服务端
// 权威记录。因此落库前必须：
// 1. 剥离服务端受信字段（verified/verification/verifiedAt/grounding/
//    verificationReport/tripCheck/demo）——否则持 token 者能把 plan 改成
//    「已核验/已确定性修复 + 假凭据链」，分享页立刻显示伪造证据；
// 2. warnings 用服务端 refreshTimeWarnings 重算（客户端可伪造预警文案）；
// 3. 整份 plan 标成 verified:false、不带 verification（spot 的历史 poi/location
//    内容保留，但撤销这一版不再宣称它被核验过——诚实优先于便利）。
// 剥离逻辑在 lib/plan-restore.ts（validateRestorePlan 返回的已是净化后的 plan）。
//
// 配额：不占生成配额（这不是重新生成）；按 IP 小时桶限流，防被当作免费写接口刷。
// 体积：整份 plan 的合法上限是 MAX_RESTORE_BYTES（300KB，真实 3 天行程约 50–100KB），
// 加 16KiB 信封余量——这是唯一需要 >64KiB 的写端点，压到审计建议的 16–64KiB
// 会让「撤销」对大行程直接失效（不可接受的可用性回归）。
// ============================================================

function restoreHourlyLimit(): number {
  return Number(process.env.RESTORE_HOURLY_LIMIT || 60);
}

/** body 上限 = 合法 plan 上限 + JSON 信封余量 */
const MAX_RESTORE_BODY_BYTES = MAX_RESTORE_BYTES + 16 * 1024;

const BodySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
  // plan 先收 unknown，再用 lib/plan-restore 的专用校验器（校验 + 剥离受信字段）
  plan: z.unknown(),
});

export async function POST(req: NextRequest) {
  // 0) 浏览器跨站写保护（纵深防御；无 Origin 的 curl/agent 放行）
  const crossSite = crossSiteWriteError(req);
  if (crossSite) {
    return NextResponse.json({ error: crossSite }, { status: 403 });
  }

  // 1) 读 body（体积上限见文件头注释）+ JSON 解析
  const body = await readJsonBody(req, MAX_RESTORE_BODY_BYTES);
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

  // 校验结构 + 剥离客户端伪造的受信字段（返回的 plan 已是净化后的）
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

  // 演示行程只读（安全审计 R4）：公开 token 不能成为公开写接口
  const blocked = demoWriteBlockedMessage(existing.plan);
  if (blocked) {
    return NextResponse.json({ error: blocked }, { status: 403 });
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

  // 2) 服务端重算时间轴/营业时间预警（客户端回传的 warnings 已被剥离）
  const restored: Plan = validated.plan;
  restored.warnings = refreshTimeWarnings(restored, existing.input);

  const record = await replacePlan(shareId, restored);
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

  console.log(
    `[restore] ${shareId} → 第 ${record.revision} 版（回到修改前；受信字段已剥离，warnings 服务端重算）`,
  );
  return NextResponse.json({ plan: record.plan, revision: record.revision });
}
