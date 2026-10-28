import { NextResponse } from "next/server";
import { TRIP_CHECK_SPEC_VERSION } from "@/lib/verify/types";

// ============================================================
// Trip Check 开放 API 的 CORS 与统一响应头
//
// 为什么开放标准必须带 CORS：这个端点的调用方是**第三方前端/agent playground**
// ——浏览器里直接 POST 自己的行程 JSON。没有 Access-Control-Allow-Origin，
// 对方连预检都过不去，开放 API 就只剩 curl 能用。
//
// 为什么抽成一个文件：/api/verify 与 /api/verify/schema 必须发同一套头，
// 各写一份必然漂移；但也不能塞进 lib/verify/（那是纯判定引擎，要保持
// client-safe、不 import Next）——放在路由目录内、只被这两个路由 import。
//
// 为什么所有响应都带 X-Trip-Check-Spec：调用方要能一眼确认对面实现的是哪一版
// 规范（版本不同判定口径可能不同）；Expose 出去浏览器 JS 才读得到。
// ============================================================

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "X-Trip-Check-Spec",
  "X-Trip-Check-Spec": TRIP_CHECK_SPEC_VERSION,
} as const;

/** JSON 响应（成功与错误共用同一套 CORS/版本头，避免错误路径漏头） */
export function jsonWithCors(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { ...CORS_HEADERS, ...extraHeaders },
  });
}

/** 空响应（OPTIONS 预检；204 不能带 body） */
export function emptyWithCors(status: number): NextResponse {
  return new NextResponse(null, { status, headers: CORS_HEADERS });
}
