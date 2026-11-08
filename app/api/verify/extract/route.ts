import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readJsonBody } from "@/lib/server/http-body";
import { crossSiteWriteError } from "@/lib/server/http-origin";
import { clientIpFromHeaders } from "@/lib/server/client-ip";
import { consume, hourKey, refund } from "@/lib/server/ratelimit";
import { tryAcquireSlot, tryReserveLlmBudget } from "@/lib/server/capacity-gate";
import { LlmError } from "@/lib/plan/planner";
import { extractTripDocument } from "@/lib/plan/trip-document-extract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/verify/extract —— 任意来源行程文本 → Trip Check 开放文档
//
// 与 /api/plan/extract 的分工（两者刻意并存，不要合并）：
//   - plan/extract：只提「规划条件」，回填表单让人核对后走完整生成管线；
//   - verify/extract：不生成任何行程，只把手上已有的行程照抄成开放文档，
//     交给 /api/verify 的确定性引擎体检。不烧生成配额、不需要高德 key。
//
// 为什么不做成 /api/verify 的一个 mode：抽取要调 LLM、有配额与并发成本，
// 而 /api/verify 是对外承诺「deterministic、不调模型」的开放端点。把两者
// 混在一个 URL 里会让「可复算」这个承诺变模糊。
//
// 防护口径沿用 plan/extract：跨站写拒绝 → 限 body → zod → 并发闸门 →
// IP 小时桶 → 全站 LLM 日预算；失败退还额度，成功才计费。
// ============================================================

const BodySchema = z.object({
  // 8000 字足够覆盖一篇游记/一份 ChatGPT 行程；上限同时约束 prompt 体量。
  text: z.string().trim().min(20, "内容太短，至少 20 个字").max(8000, "内容太长，请截取关键段落"),
});

function extractHourlyLimit(): number {
  const raw = Number(process.env.VERIFY_EXTRACT_HOURLY_LIMIT || 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 10;
}

export async function POST(req: NextRequest) {
  const crossSite = crossSiteWriteError(req);
  if (crossSite) {
    return NextResponse.json({ error: crossSite }, { status: 403 });
  }

  // 32 KiB：8000 个中文按 UTF-8 最坏约 24KB，留一倍余量给 JSON 信封。
  const body = await readJsonBody(req, 32 * 1024);
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

  const release = tryAcquireSlot("llm");
  if (!release) {
    return NextResponse.json({ error: "当前请求较多，请稍后再试" }, { status: 503 });
  }

  const limit = extractHourlyLimit();
  const winKey = hourKey("verify-extract", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    release();
    return NextResponse.json(
      { error: `验真太频繁：每小时最多 ${limit} 次，请稍后再试` },
      { status: 429 },
    );
  }

  if (!tryReserveLlmBudget()) {
    await refund(winKey);
    release();
    return NextResponse.json({ error: "今日服务调用额度已用完，请明天再试" }, { status: 429 });
  }

  try {
    const result = await extractTripDocument(parsed.data.text);
    console.log(
      `[verify/extract] tokens=${result.tokens || "?"} days=${result.document?.days.length ?? 0} 不确定项=${result.uncertain.length}`,
    );
    return NextResponse.json(result);
  } catch (e) {
    await refund(winKey);
    if (e instanceof LlmError) {
      return NextResponse.json({ error: `读取失败：${e.message}` }, { status: 502 });
    }
    console.error(`[verify/extract] 未预期失败: ${(e as Error)?.message ?? e}`);
    return NextResponse.json({ error: "读取失败：服务暂时不可用，请稍后重试" }, { status: 502 });
  } finally {
    release();
  }
}
