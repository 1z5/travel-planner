import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health —— 容器/云托管健康检查 + 配置自检（不泄露任何密钥）
export async function GET() {
  return NextResponse.json({
    status: "ok",
    uptimeSec: Math.round(process.uptime()),
    llmConfigured: Boolean(process.env.LLM_API_KEY),
    amapMode: process.env.AMAP_WEB_SERVICE_KEY ? "live" : "mock",
    authProvider: process.env.AUTH_PROVIDER || "none",
  });
}
