import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { getStore } from "@/lib/store";
import { summarize } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// GET /api/events/summary —— 只读看板（聚合值，不输出单条事件）。
//
// 为什么单独一个路由文件：Next App Router 里一个 route.ts 只服务一个路径，
// 曾把 GET 写在 /api/events/route.ts 里，结果 /api/events/summary 命中 Next
// 的 not-found（text/html 404），e2e 的「无 token → 404」因此变成假阳性——
// 断言通过但功能不存在。**断言 404 时必须确认响应体是 JSON**。
//
// 鉴权：必须带 `?token=<METRICS_TOKEN>`；未配置 METRICS_TOKEN 时一律 404
// （不暴露“这里有个看板”）。token 用 timingSafeEqual 比较，防时序侧信道。
// ============================================================

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) return false;
  const got = req.nextUrl.searchParams.get("token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 统计窗口：默认 30 天（?days= 可覆盖，1-365） */
function windowDays(req: NextRequest): number {
  const raw = Number(req.nextUrl.searchParams.get("days") ?? 30);
  if (!Number.isFinite(raw) || raw < 1) return 30;
  return Math.min(365, Math.floor(raw));
}

export async function GET(req: NextRequest) {
  if (!tokenOk(req)) {
    // JSON 404（不是 Next 的 not-found 页）：让调用方与监控能区分
    // 「看板未配置/未授权」与「路由不存在」
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const days = windowDays(req);
  const since = Date.now() - days * 86400000;
  const events = await getStore().events.list({ since, limit: 20000 });
  return NextResponse.json(summarize(events, since));
}
