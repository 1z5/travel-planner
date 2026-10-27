import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { extractTripConditions } from "@/lib/trip-extract";
import { LlmError } from "@/lib/planner";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { tryAcquireSlot, tryReserveLlmBudget } from "@/lib/capacity-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/plan/extract —— 攻略粘贴 → 行程条件提取（产品线 B 的入口）
//
// 与 /api/plan 的分工：本接口**不生成行程、不扣每日生成配额**，只做一次小 LLM
// 调用把「用户贴的攻略/群聊文本」变成结构化条件，前端回填表单让用户核对后再生成。
// 理由：
//   1) 信任——AI 把一篇软广当成我的需求直接出行程，用户连核对的机会都没有；
//   2) 成本——提取是一次小调用，生成是 1.5-9 万 token，不能让「粘错文本」烧掉配额。
//
// 滥用防护：按 IP 小时桶（默认 10 次/小时）+ 全站 LLM 日预算（与 refine/chat 共用）。
// ============================================================

const BodySchema = z.object({
  // 攻略文本：20-4000 字。下限防止空跑，上限控制 prompt 体量（也更难塞进整篇广告）。
  text: z.string().trim().min(20, "内容太短，至少 20 个字").max(4000, "内容太长，请截取关键段落"),
});

function extractHourlyLimit(): number {
  const raw = Number(process.env.EXTRACT_HOURLY_LIMIT || 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

export async function POST(req: NextRequest) {
  // 1) 参数校验（放在限流之前：坏请求不该消耗用户的小时额度）
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

  // 2) 并发闸门（与生成/改行程/管家共用 LLM 并发额度）
  const release = tryAcquireSlot("llm");
  if (!release) {
    return NextResponse.json({ error: "当前请求较多，请稍后再试" }, { status: 503 });
  }

  // 3) 限流：按 IP 小时桶
  const limit = extractHourlyLimit();
  const winKey = hourKey("extract", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    release();
    return NextResponse.json(
      { error: `提取太频繁：每小时最多 ${limit} 次，请稍后再试` },
      { status: 429 },
    );
  }

  // 4) 全站 LLM 日预算（公开站被刷时，按 IP 小时桶挡不住换 IP）
  if (!tryReserveLlmBudget()) {
    await refund(winKey);
    release();
    return NextResponse.json({ error: "今日服务调用额度已用完，请明天再试" }, { status: 429 });
  }

  try {
    const result = await extractTripConditions(parsed.data.text);
    console.log(
      `[extract] 用时完成 tokens=${result.tokens || "?"} city=${result.conditions?.city ?? "-"} 缺失=${result.missing.join("/") || "无"}`,
    );
    return NextResponse.json({
      conditions: result.conditions,
      missing: result.missing,
      tokens: result.tokens,
    });
  } catch (e) {
    await refund(winKey);
    if (e instanceof LlmError) {
      return NextResponse.json({ error: `提取失败：${e.message}` }, { status: 502 });
    }
    console.error(`[extract] 未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "提取失败：服务暂时不可用，请稍后重试" }, { status: 502 });
  } finally {
    release();
  }
}
