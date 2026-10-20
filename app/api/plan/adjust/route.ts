import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPlanForEdit, replacePlan, resolvePlan } from "@/lib/plan-repo";
import {
  RetimeUnavailableError,
  retimeDay,
  type RetimeResult,
} from "@/lib/schedule";
import { refreshTimeWarnings } from "@/lib/validate";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import type { Plan } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/adjust —— 体检预警的「确定性修复」入口（当前只有 retime）
//
// 与时序：体检发现「时间接不上」→ 前端给「一键顺延」按钮 → 这里重排当天时间轴。
//
// 为什么不用 LLM、也不占每日生成配额：
// - 顺延是纯算术（已知每段真实耗时 + 各点停留时长 → 推一遍时间），确定性
//   结果可复现、毫秒级返回、不花钱、不消耗用户配额。用模型反而是降级
//   （慢、可能不按算好的分钟数排、还可能改内容）。
// - 只按 IP 做小时桶限流防滥用（不占 REFINE/generate 的配额）。
//
// 认证模型与 refine 一致：分享 token 即凭据（可共编的工作台），last-write-wins。
// ============================================================

/** 顺延按 IP 每小时上限：确定性操作成本极低，额度可以比 refine 宽得多 */
function adjustHourlyLimit(): number {
  return Number(process.env.ADJUST_HOURLY_LIMIT || 60);
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/**
 * 无法自动顺延的统一文案（422）。
 * 覆盖三种「没数据可依据」：无 legs（未验真/MOCK）、无 startDate（旧数据）、
 * legs 与当天点位对不上（旧版本残留）。刻意给一条可行动的出口
 * （用「重排这一天」让 AI 重排），而不是让用户对着按钮反复点。
 */
const UNAVAILABLE =
  "这份行程缺少真实路段数据（未验真/旧版本），无法自动顺延时间轴；可用「重排这一天」让 AI 重排";

const BodySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
  op: z.enum(["retime"], { message: "op 只能是 retime" }),
  day: z.number().int().min(1, "天数不合法").max(10, "天数不合法"),
});

export async function POST(req: NextRequest) {
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
  const { shareId, day } = parsed.data;

  // 2) 读可编辑行程。只认持久化 Plan（share token）；旧 job 链接是只读历史结果
  const record = await getPlanForEdit(shareId);
  if (!record) {
    if (await resolvePlan(shareId)) {
      return NextResponse.json(
        { error: "这条是旧版分享链接，只读、不支持修改；请打开新生成的行程再操作" },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
  }

  // 3) 目标天必须真实存在（用户可能拿着旧页面点按钮）
  const targetDay = record.plan.days.find((d) => d.day === day);
  if (!targetDay) {
    return NextResponse.json(
      { error: `这份行程没有第 ${day} 天（共 ${record.plan.days.length} 天），请刷新页面后重试` },
      { status: 400 },
    );
  }

  // 4) 限流（确认请求有效之后再扣，坏请求不扣）
  const limit = adjustHourlyLimit();
  const winKey = hourKey("adjust", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `顺延时间轴每小时 ${limit} 次，已用完，请稍后再试` },
      { status: 429 },
    );
  }

  // 5) 确定性重排（纯算术，毫秒级）
  const t0 = Date.now();
  let result: RetimeResult;
  try {
    result = retimeDay(record.plan, record.input, day);
  } catch (e) {
    await refund(winKey); // 失败不消耗名额（与 refine/生成同口径）
    if (e instanceof RetimeUnavailableError) {
      // day_not_found 是防御性分支（上面已先校验）：仍按 400 返回，语义准确
      const status = e.code === "day_not_found" ? 400 : 422;
      return NextResponse.json(
        { error: e.code === "day_not_found" ? e.message : UNAVAILABLE },
        { status },
      );
    }
    console.error(`[adjust] ${shareId} 第 ${day} 天 retime 未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json(
      { error: "顺延时间轴失败：服务暂时不可用，请稍后重试" },
      { status: 500 },
    );
  }

  // 6) 无需改动：不落库、不涨 revision。前端据此提示「时间轴本来就是接得上的」
  if (!result.changed) {
    console.log(
      `[adjust] ${shareId} 第 ${day} 天 retime changed=false 用时 ${Date.now() - t0}ms`,
    );
    return NextResponse.json({
      plan: record.plan,
      revision: record.revision,
      changed: false,
      notes: result.notes,
    });
  }

  // 7) 落库前只刷新「时间轴 / 营业时间」两类预警：
  //    顺延会改变 spot.time，这两类结论必须跟着变；而 POI/预算/节奏/天气
  //    等其它预警的结论与时间无关（且重算要及时序网络调用），保持原样。
  const nextPlan: Plan = {
    ...record.plan,
    days: record.plan.days.map((d) => (d.day === day ? result.day : d)),
  };
  nextPlan.warnings = refreshTimeWarnings(nextPlan, record.input);

  const saved = await replacePlan(shareId, nextPlan);
  if (!saved) {
    await refund(winKey);
    return NextResponse.json({ error: "行程不存在或已被删除，修改未能保存" }, { status: 404 });
  }

  console.log(
    `[adjust] ${shareId} 第 ${day} 天 retime changed=true 用时 ${Date.now() - t0}ms revision=${saved.revision}${result.notes.length ? ` 说明=${result.notes.join("；")}` : ""}`,
  );
  return NextResponse.json({
    plan: saved.plan,
    revision: saved.revision,
    changed: true,
    notes: result.notes,
  });
}
