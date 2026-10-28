import { TRIP_CHECK_JSON_SCHEMA } from "@/lib/verify/schema";
import { emptyWithCors, jsonWithCors } from "../cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================
// GET /api/verify/schema —— Trip Check v0.1 开放文档的 JSON Schema
//
// 为什么单独一个端点：第三方要在**提交前**自己校验文档格式（CI、编辑器、
// agent 工具链），不能靠读我们的源码或文档正文。schema 是手写的稳定契约
// （见 lib/verify/schema.ts），内容只随规范版本变化。
//
// 为什么允许缓存 1 小时：schema 是纯常量，没有隐私/用户态；公开分发、
// 每个调用方每小时拉一次足够（规范也会提前写进 X-Trip-Check-Spec）。
// ============================================================
export async function GET() {
  return jsonWithCors(TRIP_CHECK_JSON_SCHEMA, 200, {
    "Cache-Control": "public, max-age=3600",
  });
}

/** OPTIONS /api/verify/schema —— CORS 预检（浏览器可以直接 fetch schema） */
export async function OPTIONS() {
  return emptyWithCors(204);
}
