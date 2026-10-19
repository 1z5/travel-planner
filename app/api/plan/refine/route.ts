import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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
// POST /api/plan/refine —— 「跟 AI 说一句」改一天 / 单点「换一个」
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
    action: z.enum(["swap", "day"], { message: "action 只能是 swap 或 day" }),
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
  })
  .refine((d) => d.action !== "swap" || d.spotIndex !== undefined, {
    message: "「换一个」需要 spotIndex",
    path: ["spotIndex"],
  })
  // 契约上 swap 不带指令：静默忽略等于吞掉用户的话，明确告知改用「重排这一天」
  .refine((d) => d.action !== "swap" || d.instruction === undefined, {
    message: "「换一个」不支持附加指令，请改用「重排这一天」",
    path: ["instruction"],
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
  const { shareId, action, day, spotIndex, instruction } = parsed.data;

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
      : { kind: "day", day, instruction };

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

  console.log(
    `[refine] ${shareId} 第 ${day} 天 ${action} 完成 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s revision=${saved.revision}`,
  );
  return NextResponse.json({ plan: saved.plan, revision: saved.revision });
}
