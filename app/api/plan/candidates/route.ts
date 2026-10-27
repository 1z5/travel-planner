import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getPlanForEdit, replacePlan } from "@/lib/plan-repo";
import { buildReplacementSpot, findCandidates } from "@/lib/candidates";
import { lookupPoi, AMAP_MOCK, type PoiLookup } from "@/lib/amap";
import { validatePlan } from "@/lib/validate";
import { consume, hourKey, refund } from "@/lib/ratelimit";
import { clientIpFromHeaders } from "@/lib/client-ip";
import { getStore } from "@/lib/store";
import { newEventId } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// 真实候选对比（产品线 S4 v0）
//
// GET  /api/plan/candidates?shareId&day&spotIndex —— 看 3 个真实替代点
// POST /api/plan/candidates                        —— 用选中的候选确定性替换
//
// 为什么不做成「再调一次模型」：模型每次输出不同，用户没法比较；而候选对比是
// 「同一批真实数据里自己挑」，替换也是确定性的（不重抽、不改其他站）。
//
// 认证：分享 token 即凭据（与 refine/restore 同口径）。
// 护栏：GET/POST 共用按 IP 小时桶（默认 60/h）——候选检索会打高德，不能白刷。
// ============================================================

function hourlyLimit(): number {
  return Number(process.env.CANDIDATES_HOURLY_LIMIT || 60);
}

const QuerySchema = z.object({
  shareId: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确"),
  day: z.coerce.number().int().min(1).max(10),
  spotIndex: z.coerce.number().int().min(0).max(20),
});

const ApplySchema = QuerySchema.extend({
  // 名称白名单：中文/字母/数字/间隔号/括号/空格，1-80 字（防注入面）
  name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[\u4e00-\u9fa5A-Za-z0-9·（）()\-\s]+$/, "地点名称格式不正确"),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const { shareId, day, spotIndex } = parsed.data;

  const record = await getPlanForEdit(shareId);
  if (!record) {
    return NextResponse.json({ error: "这份行程不存在或已被删除" }, { status: 404 });
  }

  const winKey = hourKey("candidates", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, hourlyLimit());
  if (!quota.allowed) {
    return NextResponse.json({ error: "候选查询太频繁，请稍后再试" }, { status: 429 });
  }

  const result = await findCandidates(record.plan, record.input, day, spotIndex);
  if (result.state === "unavailable") {
    await refund(winKey); // 上游不可用不该吃掉用户额度
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }
  return NextResponse.json({ candidates: result.candidates, prevName: result.prevName });
}

export async function POST(req: NextRequest) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "请求格式不正确，需要 JSON body" }, { status: 400 });
  }
  const parsed = ApplySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不正确" },
      { status: 400 },
    );
  }
  const { shareId, day, spotIndex, name } = parsed.data;

  // MOCK 模式没有真实坐标：替换后行程会「看起来验真过」，直接拒绝
  if (AMAP_MOCK) {
    return NextResponse.json(
      { error: "未接入高德（MOCK 模式），不能替换成未核验的地点" },
      { status: 503 },
    );
  }

  const record = await getPlanForEdit(shareId);
  if (!record) {
    return NextResponse.json({ error: "这份行程不存在或已被删除" }, { status: 404 });
  }
  const dayPlan = record.plan.days.find((d) => d.day === day);
  const oldSpot = dayPlan?.spots[spotIndex];
  if (!dayPlan || !oldSpot) {
    return NextResponse.json({ error: "找不到这个行程点" }, { status: 400 });
  }

  const winKey = hourKey("candidates", clientIpFromHeaders(req.headers));
  const quota = await consume(winKey, hourlyLimit());
  if (!quota.allowed) {
    return NextResponse.json({ error: "替换太频繁，请稍后再试" }, { status: 429 });
  }

  // 服务端**重新验真**选中的地点：不信任客户端回传的数据
  const lookup: PoiLookup = await lookupPoi(record.input.city, name, record.input.scope ?? "city");
  if (lookup.state !== "hit") {
    await refund(winKey);
    return NextResponse.json(
      {
        error:
          lookup.state === "miss"
            ? `高德没能核验到「${name}」，不能替换（不猜）`
            : `核验失败：${lookup.reason}`,
      },
      { status: lookup.state === "miss" ? 422 : 503 },
    );
  }

  // 深拷贝后替换：不修改原对象（record.plan 引用来自 store）
  const nextPlan = structuredClone(record.plan);
  const nextDay = nextPlan.days.find((d) => d.day === day);
  if (!nextDay) {
    await refund(winKey);
    return NextResponse.json({ error: "找不到这个行程点" }, { status: 400 });
  }
  nextDay.spots[spotIndex] = buildReplacementSpot(oldSpot, lookup.poi);
  // 这一天的旧 legs 已失效（相邻点变了）：清掉让体检重算，避免 UI 显示错路线
  delete nextDay.legs;

  // 重跑当天体检（通勤/时间轴/营业时间/节奏全部重算）——换点后风险必须重新摊开
  await validatePlan(nextPlan, record.input, [day]);

  const saved = await replacePlan(shareId, nextPlan);
  if (!saved) {
    await refund(winKey);
    return NextResponse.json({ error: "这份行程不存在或已被删除" }, { status: 404 });
  }

  // 埋点：用户自己换了某一天的一个点（op=candidate 与 LLM 路径区分开）
  try {
    await getStore().events.record({
      id: newEventId(),
      name: "day_modified",
      shareId,
      city: record.plan.city,
      day,
      meta: { op: "candidate" },
      createdAt: Date.now(),
    });
  } catch {
    /* 埋点失败不阻塞替换 */
  }

  console.log(
    `[candidates] ${shareId} 第${day}天第${spotIndex + 1}站 → ${name}（第 ${saved.revision} 版）`,
  );
  return NextResponse.json({ plan: saved.plan, revision: saved.revision });
}
