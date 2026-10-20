import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  FIX_KINDS,
  FixDataError,
  fixInstruction,
  resolveFixDay,
  type FixKind,
} from "@/lib/fix-actions";
import { getPlanForEdit, replacePlan, resolvePlan } from "@/lib/plan-repo";
import {
  refinePlan,
  RefineLlmError,
  RefineOutputError,
  RefineRejectedError,
  type RefineAction,
} from "@/lib/refine";
import { consume, hourKey, refund } from "@/lib/ratelimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/refine —— 「跟 AI 说一句」改一天 / 单点「换一个」/ 体检「一键修复」
//
// 同步接口：一次模型调用 20-90 秒（内容层重试时最多两次），可接受——
// 改一个点的交互比整份重新生成（3-4 分钟）快一个量级，用户愿意等。
//
// 与生成接口的配额关系：**不占每日生成配额**。改行程是编辑已有成果，
// 不是重新生成：让一次「换一个」吃掉当天 3 次免费生成里的一次是不合理的
// （用户会为了保留修改机会而不敢生成）。改行程走独立的按 IP 小时桶限流，
// 只防滥用（防把本服务当免费 LLM 代理刷），不参与产品配额。
//
// 认证模型：分享 token 即凭据（与分享页/ics 同口径）——目标是「拿到链接的人
// 可以一起编」，这也是本轮产品定位（可共编的工作台）。并发编辑是
// last-write-wins，取舍见 refinePlan/plan-repo 注释。
//
// 「一键修复」（action=fix）本轮新增：体检预警旁边点一下就修。它与 day 动作
// 走**完全相同**的 refinePlan→重体检→replacePlan 链路，区别只在指令来源——
// fix 的指令由服务端 lib/fix-actions.ts 的 fixInstruction 用模板生成，
// **不接受客户端传入的自由文本**（防提示注入，也保证「只改一天/不删硬约束」
// 的措辞由我们掌握）。客户端只能指定 fixKind + day。
// ============================================================

/** 改行程按 IP 计数上限（每小时）。生成配额是每日的，改行程是每小时的——编辑频率天然更高 */
function refineHourlyLimit(): number {
  return Number(process.env.REFINE_HOURLY_LIMIT || 20);
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

// 指令白名单：中文 + 字母数字 + 常见中文标点/空格。
// 刻意不含引号、反斜杠、花括号、换行——这些是拼进 prompt 的注入面。
// 路由层是用户输入进入 prompt 的唯一入口，白名单比转义更可验证
// （lib/refine.ts 的 sanitizeInstruction 是第二道防线）。
const INSTRUCTION_RE = /^[\u4e00-\u9fa5A-Za-z0-9 ，。、；：？！…—·（）()\-.,;:?!]{1,100}$/;

const BodySchema = z
  .object({
    shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
    action: z.enum(["swap", "day", "fix"], { message: "action 只能是 swap、day 或 fix" }),
    day: z.number().int().min(1, "天数不合法").max(10, "天数不合法"),
    // swap 必填：当天第几个行程点（0 基，与 plan.days[].spots 下标一致）
    spotIndex: z.number().int().min(0, "行程点序号不合法").max(20, "行程点序号不合法").optional(),
    // day 模式可选：不给就是「按当天主题重排」。空字符串按未给处理（前端输入框常见）
    instruction: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z
        .string()
        .trim()
        .max(100, "指令最多 100 字")
        .regex(INSTRUCTION_RE, "指令只能包含中文、字母数字和常见标点（不能有引号/换行/括号）")
        .optional(),
    ),
    // fix 必填：修复类型。枚举与 lib/fix-actions.ts 的 FIX_KINDS 同源，避免两处漂移。
    // 未知取值由 zod 统一挡成 400（文案列出全部合法值，便于排查）。
    fixKind: z
      .enum(FIX_KINDS, { message: `fixKind 只能是 ${FIX_KINDS.join(" / ")}` })
      .optional(),
  })
  .refine((d) => d.action !== "swap" || d.spotIndex !== undefined, {
    message: "「换一个」需要 spotIndex",
    path: ["spotIndex"],
  })
  // 契约上 swap 不带指令：静默忽略等于吞掉用户的话，明确告知改用「重排这一天」
  .refine((d) => d.action !== "swap" || d.instruction === undefined, {
    message: "「换一个」不支持附加指令，请改用「重排这一天」",
    path: ["instruction"],
  })
  // swap 也不接受 fixKind：两种改法语义不同，混着传说明前端调错了
  .refine((d) => d.action !== "swap" || d.fixKind === undefined, {
    message: "「换一个」不支持 fixKind（那是「一键修复」的参数）",
    path: ["fixKind"],
  })
  .refine((d) => d.action !== "fix" || d.fixKind !== undefined, {
    message: "「一键修复」需要 fixKind（修复类型）",
    path: ["fixKind"],
  })
  // fix 不接受 spotIndex / instruction：指令由服务端模板生成，客户端改不了措辞
  .refine((d) => d.action !== "fix" || d.spotIndex === undefined, {
    message: "「一键修复」不支持 spotIndex",
    path: ["spotIndex"],
  })
  .refine((d) => d.action !== "fix" || d.instruction === undefined, {
    message: "「一键修复」使用服务端模板指令，不接受自定义 instruction",
    path: ["instruction"],
  })
  // fixKind 只属于 fix 动作；day 传了说明前端没切对 action
  .refine((d) => d.action !== "day" || d.fixKind === undefined, {
    message: "「重排这一天」不支持 fixKind，请改用 action=\"fix\"",
    path: ["fixKind"],
  });

/** fix 动作成功时附加在响应上的说明（day/swap 响应保持原样，不含此字段） */
interface AppliedFix {
  fixKind: FixKind;
  instruction: string;
}

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
  const { shareId, action, day, spotIndex, instruction, fixKind } = parsed.data;

  // 2) 读可编辑行程。只认持久化 Plan（share token）；旧 jobId 链接是只读历史结果，
  //    顺手给出比「不存在」更可行动的文案（否则用户会以为是系统丢了数据）。
  const record = await getPlanForEdit(shareId);
  if (!record) {
    if (await resolvePlan(shareId)) {
      return NextResponse.json(
        { error: "这条是旧版分享链接，只读、不支持修改；请打开新生成的行程再编辑" },
        { status: 404 },
      );
    }
    return NextResponse.json({ error: "行程不存在或已被删除" }, { status: 404 });
  }

  // 3) 目标位置必须真实存在于这份行程（用户可能拿着旧页面点按钮）
  const targetDay = record.plan.days.find((d) => d.day === day);
  if (!targetDay) {
    return NextResponse.json(
      { error: `这份行程没有第 ${day} 天（共 ${record.plan.days.length} 天），请刷新页面后重试` },
      { status: 400 },
    );
  }
  if (action === "swap" && spotIndex !== undefined && spotIndex >= targetDay.spots.length) {
    return NextResponse.json(
      { error: `第 ${day} 天没有第 ${spotIndex + 1} 个行程点，请刷新页面后重试` },
      { status: 400 },
    );
  }

  // 3b) fix 动作：服务端把 fixKind 翻成模板指令。
  //     放在限流之前——「这条预警现在没有可修的余地」不是用户的错，不该扣次数；
  //     数据不足（FixDataError）映射 422 并给可行动的替代方案。
  let effectiveDay = day;
  let appliedFix: AppliedFix | undefined;
  if (action === "fix") {
    const kind = fixKind!;
    try {
      // 预算类 fixKind 的「改哪天」由花费决定（忽略请求 day），其余就是请求的那天；
      // 指令里的天号与 refineAction 的 day 必须一致，所以都用 resolveFixDay 的结果。
      effectiveDay = resolveFixDay(record.plan, kind, day);
      appliedFix = {
        fixKind: kind,
        instruction: fixInstruction(record.plan, record.input, kind, effectiveDay),
      };
    } catch (e) {
      if (e instanceof FixDataError) {
        return NextResponse.json({ error: e.message }, { status: 422 });
      }
      // 模板/数据之外的意外：不透出内部细节，只给可行动信息
      console.error(`[refine] ${shareId} 一键修复(${kind})失败: ${(e as Error)?.message ?? e}`);
      return NextResponse.json(
        { error: "一键修复失败：服务暂时不可用，请稍后重试或改用「重排这一天」" },
        { status: 502 },
      );
    }
  }

  // 4) 限流（放在「确认请求有效」之后、调模型之前：坏请求不扣、也不白烧一次调用）
  const limit = refineHourlyLimit();
  const winKey = hourKey("refine", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json(
      { error: `改行程每小时 ${limit} 次，已用完，请稍后再试` },
      { status: 429 },
    );
  }

  const refineAction: RefineAction =
    action === "swap"
      ? { kind: "swap", day, spotIndex: spotIndex! }
      : {
          kind: "day",
          // fix 与 day 唯一的区别就是指令来源：这里一定是服务端模板生成的文本
          day: action === "fix" ? effectiveDay : day,
          instruction: action === "fix" ? appliedFix!.instruction : instruction,
        };

  // 5) 调模型 + 校验 + 重新体检（不落库）。失败退还名额：一次失败不该吃掉
  //    用户这一次修改机会（与生成接口的失败退款同口径）。
  const t0 = Date.now();
  let newPlan;
  try {
    newPlan = await refinePlan(record.plan, record.input, refineAction);
  } catch (e) {
    await refund(winKey);
    if (e instanceof RefineRejectedError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof RefineOutputError) {
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    if (e instanceof RefineLlmError) {
      return NextResponse.json({ error: `改行程失败：${e.message}` }, { status: 502 });
    }
    // 体检/未知异常：不透出内部细节，只给可行动信息
    console.error(`[refine] ${shareId} 未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json(
      { error: "改行程失败：服务暂时不可用，请稍后重试" },
      { status: 502 },
    );
  }

  // 6) 落库（revision+1，分享页/.ics/OG 会自动读到新 plan）。null = 链接刚被删掉
  const saved = await replacePlan(shareId, newPlan);
  if (!saved) {
    await refund(winKey);
    return NextResponse.json({ error: "行程不存在或已被删除，修改未能保存" }, { status: 404 });
  }

  // 日志带上 fixKind（排障时能一眼区分「用户自己说的」与「一键修复模板」）；
  // 预算类修复的请求 day 与实际改的天可能不同，用 effectiveDay 并标注差异。
  const dayLabel =
    action === "fix" && effectiveDay !== day
      ? `第 ${effectiveDay} 天（请求第 ${day} 天，一键修复按花费自动选定）`
      : `第 ${day} 天`;
  const actionLabel = action === "fix" ? `fix(${appliedFix!.fixKind})` : action;
  console.log(
    `[refine] ${shareId} ${dayLabel} ${actionLabel} 完成 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s revision=${saved.revision}`,
  );
  // day/swap 的响应结构保持 100% 不变；只有 fix 多一个 appliedFix（便于前端
  // 展示「AI 实际收到的指令」与 e2e 断言，不泄露任何内部信息）。
  return NextResponse.json({
    plan: saved.plan,
    revision: saved.revision,
    ...(appliedFix ? { appliedFix } : {}),
  });
}
