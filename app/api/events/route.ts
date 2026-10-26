import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getStore } from "@/lib/store";
import { consume, hourKey } from "@/lib/ratelimit";
import { EVENT_NAMES, newEventId } from "@/lib/metrics";
import { clientIpFromHeaders } from "@/lib/client-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// POST /api/events —— 产品事件埋点（度量闭环的写入端）。
//
// 隐私口径（与 lib/metrics.ts 一致）：只收 shareId（用户本就持有的 token）、
// 城市、第几天、少量布尔/枚举 meta。**不收手机号、不收 IP 进事件表、不收行程内容**。
// IP 只用于限流（hourKey），不落库。
//
// 失败不阻塞：埋点写入失败也返回 204——看板少一条可以，把用户操作拖坏不行。
// ============================================================

const BodySchema = z.object({
  name: z.enum(EVENT_NAMES, { message: "未知的事件名" }),
  shareId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{6,40}$/, "行程链接格式不正确")
    .optional(),
  city: z.string().max(40).optional(),
  day: z.number().int().min(1).max(30).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** 埋点限流：每 IP 每小时 300 条（正常浏览远到不了；防刷） */
function eventHourlyLimit(): number {
  return Number(process.env.EVENT_HOURLY_LIMIT || 300);
}

// IP 由 lib/client-ip 统一提取（不再取 XFF 首值：客户端可伪造，见审计 P0-3）。
// 埋点限流本来就只是防刷，伪造 IP 影响有限；但口径必须与其它端点一致，
// 否则「换头即新用户」在埋点侧同样成立。
function clientIp(req: NextRequest): string {
  return clientIpFromHeaders(req.headers);
}

export async function POST(req: NextRequest) {
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

  const limit = eventHourlyLimit();
  const winKey = hourKey("events", clientIp(req));
  const quota = await consume(winKey, limit);
  if (!quota.allowed) {
    return NextResponse.json({ error: "上报太频繁，本次已忽略" }, { status: 429 });
  }

  const d = parsed.data;
  try {
    await getStore().events.record({
      id: newEventId(),
      name: d.name,
      shareId: d.shareId,
      city: d.city,
      day: d.day,
      meta: d.meta,
      createdAt: Date.now(),
    });
  } catch {
    /* 埋点失败不阻塞用户操作 */
  }
  return new NextResponse(null, { status: 204 });
}
