import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { demoWriteBlockedMessage } from "@/lib/demo-seed";
import { readJsonBody } from "@/lib/http-body";
import { crossSiteWriteError } from "@/lib/http-origin";
import { newEventId } from "@/lib/metrics";
import { getPlanForEdit, replacePlan, resolvePlan } from "@/lib/plan-repo";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { getStore } from "@/lib/store";
import type { Plan } from "@/lib/types";
import { refreshTimeWarnings } from "@/lib/validate";
import { planToDocument } from "@/lib/verify/adapt";
import { credentialOf } from "@/lib/verify/credential";
import { repairDocument } from "@/lib/verify/repair";
import type { RepairApplied } from "@/lib/verify/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/repair —— 产品内「确定性修复 + 写回新版本」
//
// 与开放端点 POST /api/verify/repair 的区别：
// - /api/verify/repair 是**无状态建议**：返回修复后的文档，绝不写库（persisted:false）；
// - 本端点是**产品内写操作**：先预览（confirm:false），用户确认后把机械修复套回
//   **内部 Plan**（保留 period/poi/legs 等开放文档没有的字段），revision+1 落库，
//   并把「前后凭据链 + 修复次数」记到 plan.tripCheck 上——分享页/工作台据此显示
//   「已确定性修复 · 修复链 parent → child」。
//
// 铁律：
// 1) 只允许**持久化 Plan**（旧 job 链接只读，404）——job 是一次性执行记录，不是可编辑聚合；
// 2) 只做 repairDocument 判定的机械变换（顺延时间/删同日重复），不编造事实、不替用户取舍；
// 3) 写回前自检「套回后的 Plan 与修复后文档逐点一致」，不一致宁可不写（500 + 退还限流名额）；
// 4) 并发基准用 expectedRevision：给定且与当前版本不符 → 409，不覆盖别人的修改；
// 5) 限流失败的请求 refund（与 refine/restore 同口径：一次失败不该吃掉用户次数）。
//
// 为什么 confirm 分两步（预览 → 确认）：这是会改用户行程的写操作，必须先把
// 「改了哪几处、修不了什么、前后结论/凭据」摊开给用户看；预览不落库、不推进 revision。
// ============================================================

function repairHourlyLimit(): number {
  return Number(process.env.REPAIR_HOURLY_LIMIT || 30);
}

const BodySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/, "行程链接格式不正确"),
  /** 缺省/false = 只预览；true = 真实写回（revision+1） */
  confirm: z.boolean().optional(),
  /** 并发基准：客户端从 check/preview 拿到的 planRevision；缺省 = 不做版本校验 */
  expectedRevision: z.number().int("版本号必须是整数").min(1, "版本号不合法").optional(),
});

/**
 * 把 repairDocument 的机械变更套回内部 Plan（不修改入参，返回新对象）。
 *
 * 为什么不能直接用修复后的开放文档替换 Plan：Plan 的 spot 还有 period/reason/
 * rainBackup/poi 等文档里没有的字段，也不该为了修复丢掉它们。applied 里的
 * `spotIndex` 是**输入文档当天 spots 数组的原始下标**（与 plan.days[].spots 同序，
 * planToDocument 只是搬运），因此可以逆向下标套回：
 * - 时间类（TC-C102/C103）：spot.time = applied.to（原位覆盖，不改数组长度）；
 * - 删除类（TC-C109）：按原始下标**降序** splice（降序保证前面的下标不漂移）。
 *
 * 顺序必须是「先改时间、后删点」：删除会让下标漂移，而时间类下标同样是原始下标。
 */
function applyRepairToPlan(plan: Plan, applied: readonly RepairApplied[]): Plan {
  // Plan 是纯 JSON（无 Date/Map/函数），JSON 往返是最稳的深拷贝（与 verify/repair 同口径）
  const next = JSON.parse(JSON.stringify(plan)) as Plan;
  const byDay = new Map(next.days.map((day) => [day.day, day]));

  // 1) 时间类（按原始下标原位改 time）
  for (const change of applied) {
    if (change.ruleId === "TC-C109") continue;
    if (change.spotIndex === undefined || change.to === undefined) continue;
    const day = byDay.get(change.day);
    const spot = day?.spots[change.spotIndex];
    if (!day || !spot) continue;
    spot.time = change.to;
  }

  // 2) 删除类（按天分组、原始下标降序 splice）
  const deletionsByDay = new Map<number, number[]>();
  for (const change of applied) {
    if (change.ruleId !== "TC-C109" || change.spotIndex === undefined) continue;
    const list = deletionsByDay.get(change.day) ?? [];
    list.push(change.spotIndex);
    deletionsByDay.set(change.day, list);
  }
  for (const [dayNo, indexes] of deletionsByDay) {
    const day = byDay.get(dayNo);
    if (!day) continue;
    for (const index of [...indexes].sort((a, b) => b - a)) {
      if (index >= 0 && index < day.spots.length) day.spots.splice(index, 1);
    }
    // 删点后派生金额必须跟着重算，否则预算/花费展示会停在旧数字（不猜：只做算术）
    day.dailyCostCny = day.spots.reduce((sum, spot) => sum + spot.costCny, 0);
  }
  // 总花费是每日花费之和（与 lib/validate.ts finalizePlan 的口径一致）
  next.totalCostCny = next.days.reduce((sum, day) => sum + day.dailyCostCny, 0);

  // 注意：plan.days[].legs / transitMin 不在此重算——重算真实路段要打高德（同步接口
  // 不能做），而且删除同一天重复点时，legs 也来自同一次验真、不会凭空多出一段；
  // 残留的旧段按 from/to 名称查找，绝不会被错误点消费（消费方见 components/PlanView）。
  return next;
}

/** 套回后自检：Plan 与 repair.document 必须逐天逐点（名称+时间）一致，否则不写 */
function assertsPlanMatchesDocument(plan: Plan, document: ReturnType<typeof planToDocument>): void {
  const rebuilt = planToDocument(plan, { id: document.id });
  const sameLength = rebuilt.days.length === document.days.length;
  const consistent =
    sameLength &&
    rebuilt.days.every((day, dayIndex) => {
      const target = document.days[dayIndex];
      if (!target || day.spots.length !== target.spots.length) return false;
      return day.spots.every((spot, spotIndex) => {
        const expected = target.spots[spotIndex];
        return Boolean(expected) && spot.name === expected.name && spot.time === expected.time;
      });
    });
  if (!consistent) {
    // 诊断信息要能直接定位到「哪天、哪个下标、名字/时间哪一项不一致」：
    // 这条路径一旦触发就是拒绝写入（宁可不写，也不写半截），没有上下文会很难排查。
    const detail: string[] = [];
    rebuilt.days.forEach((day, dayIndex) => {
      const target = document.days[dayIndex];
      if (!target) {
        detail.push(`day[${dayIndex}] 缺失`);
        return;
      }
      if (day.spots.length !== target.spots.length) {
        detail.push(`day ${day.day} 点位数 ${day.spots.length} != ${target.spots.length}`);
        return;
      }
      day.spots.forEach((spot, spotIndex) => {
        const expected = target.spots[spotIndex];
        if (!expected) {
          detail.push(`day ${day.day} spot[${spotIndex}] 文档缺失`);
          return;
        }
        if (spot.name !== expected.name || spot.time !== expected.time) {
          detail.push(
            `day ${day.day} spot[${spotIndex}] plan=「${spot.name} ${spot.time}」 doc=「${expected.name} ${expected.time}」`,
          );
        }
      });
    });
    throw new Error(
      `修复变更无法安全套回 Plan（applied.spotIndex 语义不一致）: ${detail.slice(0, 6).join("；")}`,
    );
  }
}

export async function POST(req: NextRequest) {
  // 0) 浏览器跨站写保护：cookie 认证的写端点必须同源（无 Origin 的 curl/agent 放行）。
  //    这是纵深防御；分享 token 本身仍是匿名写的主要凭据。
  const crossSite = crossSiteWriteError(req);
  if (crossSite) {
    return NextResponse.json({ error: crossSite }, { status: 403 });
  }

  // 1) 参数校验（放在限流之前：畸形请求不消耗小时额度）；体积上限 16 KiB
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
  const { shareId, confirm, expectedRevision } = parsed.data;

  // 2) 只允许持久化 Plan：旧 job 链接只读（能体检但不能改）
  const record = await getPlanForEdit(shareId);
  if (!record) {
    if (await resolvePlan(shareId)) {
      return NextResponse.json(
        { error: "这条是旧版分享链接，只读、不支持修复；请打开新生成的行程再操作" },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
  }

  // 2b) 演示行程只读（安全审计 R4）：必须在限流/写回之前判断——
  //     否则公开 token 既可能被刷额度，也可能被真的改坏演示工件。
  const demoBlocked = demoWriteBlockedMessage(record.plan);
  if (demoBlocked) {
    return NextResponse.json({ error: demoBlocked }, { status: 403 });
  }

  // 3) 限流（确认行程有效之后再扣；失败路径 refund，一次失败不吃用户次数）
  const limit = repairHourlyLimit();
  const winKey = hourKey("plan-repair", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `修复太频繁：每小时最多 ${limit} 次，请稍后再试`, limit },
      { status: 429 },
    );
  }

  const now = new Date();
  try {
    // 4) 判定 + 机械修复：全是确定性计算（不调模型、不写库、不读当前时间做判定）
    const document = planToDocument(record.plan, { id: shareId });
    const repaired = repairDocument(document, {}, now);
    const parentCredential = credentialOf(document, {}, now);
    const credential = credentialOf(repaired.document, {}, now);
    const changed = repaired.applied.length > 0;
    const outcome = {
      before: repaired.before,
      after: repaired.after,
      applied: repaired.applied,
      unrepairable: repaired.unrepairable,
      parentCredential,
      credential,
    };

    // 5) 预览：不落库、不推进 revision（用户看过再决定）
    if (confirm !== true) {
      return NextResponse.json({
        changed,
        persisted: false,
        planRevision: record.revision,
        ...outcome,
      });
    }

    // 6) 并发校验：别人已经改过（版本不符）就不覆盖，让客户端刷新后用新版本重试
    if (expectedRevision !== undefined && expectedRevision !== record.revision) {
      await refund(winKey);
      return NextResponse.json(
        {
          error: `行程已被修改（当前第 ${record.revision} 版），请刷新后重试`,
          revision: record.revision,
        },
        { status: 409 },
      );
    }

    // 7) 没有可机械修复的问题：如实返回未写（不为了「看起来有用」而改东西）
    if (!changed) {
      return NextResponse.json({
        changed: false,
        persisted: false,
        planRevision: record.revision,
        ...outcome,
      });
    }

    // 8) 套回 Plan + 自检 + 刷新产品内时间轴/营业时间预警
    //    为什么要刷 warnings：ExecutabilityBadge/fix-actions 直接读 plan.warnings，
    //    不刷新会出现「判定说已修复、徽章仍报时间接不上」的自相矛盾。
    const nextPlan = applyRepairToPlan(record.plan, repaired.applied);
    assertsPlanMatchesDocument(nextPlan, repaired.document);
    nextPlan.warnings = refreshTimeWarnings(nextPlan, record.input);
    const previousRepairCount = record.plan.tripCheck?.repairCount ?? 0;
    nextPlan.tripCheck = {
      credentialId: credential.id,
      parentCredentialId: parentCredential.id,
      checkedAt: now.getTime(),
      repairedAt: now.getTime(),
      repairCount: previousRepairCount + 1,
      applied: repaired.applied.length,
    };

    // 9) 落库（revision+1）。null = 链接在计算期间被删掉 → 404 + 退还名额
    const saved = await replacePlan(shareId, nextPlan);
    if (!saved) {
      await refund(winKey);
      return NextResponse.json({ error: "行程不存在或已被删除，修复未能保存" }, { status: 404 });
    }

    // 10) 埋点：「体检 → 修复」闭环的使用频次（失败不阻塞修复，与 restore 同口径）
    try {
      await getStore().events.record({
        id: newEventId(),
        name: "plan_repaired",
        shareId,
        city: saved.plan.city,
        meta: { applied: repaired.applied.length, repairCount: nextPlan.tripCheck.repairCount },
        createdAt: Date.now(),
      });
    } catch {
      /* 埋点失败不阻塞修复 */
    }

    console.log(
      `[plan-repair] ${shareId} → 第 ${saved.revision} 版（确定性修复 ${repaired.applied.length} 处，阻断 ${repaired.before.stats.blocking}→${repaired.after.stats.blocking}）`,
    );
    return NextResponse.json({
      changed: true,
      persisted: true,
      revision: saved.revision,
      plan: saved.plan,
      ...outcome,
    });
  } catch (e) {
    // 任何未预期异常：退还名额 + 可解析错误（不把半截结果写进存储）
    await refund(winKey);
    console.error(`[plan-repair] ${shareId} 修复失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "修复失败：服务暂时不可用，请稍后重试" }, { status: 500 });
  }
}
