import { TRIP_CHECK_OPENAPI } from "@/lib/verify/openapi";
import { emptyWithCors, jsonWithCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// GET /api/verify/openapi —— Trip Check 的 OpenAPI 3.1 契约
//
// 为什么单独一个端点：调用方是 SDK 生成器 / API 网关 / agent，需要**机器可读**
// 的接口描述（人读的 API.md 无法被工具消费）。文档里 document schema 直接引用
// 公开文档常量（lib/verify/schema.ts），不手抄副本。
//
// 为什么允许缓存 1 小时：契约是纯常量（只随引擎/规则版本变化），没有隐私/用户态；
// 公开分发 + CDN 缓存能挡住目录类工具的轮询。版本轴写进 x-trip-check 扩展，
// 调用方拿响应头 X-Trip-Check-Spec 也能确认规范版本。
// ============================================================
export async function GET() {
  return jsonWithCors(TRIP_CHECK_OPENAPI, 200, {
    "Cache-Control": "public, max-age=3600",
  });
}

/** OPTIONS /api/verify/openapi —— CORS 预检（浏览器里的工具可直接取契约） */
export async function OPTIONS() {
  return emptyWithCors(204);
}
