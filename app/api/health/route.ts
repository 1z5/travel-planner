import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health —— 容器/云托管健康检查 + 配置自检（不泄露任何密钥）。
//
// 只回显环境变量是不够的：DATA_STORE=postgres 时数据库连不上，服务依旧返回
// 「status:ok」——探活就会把流量继续送给一个必然 500 的实例。所以 postgres
// 模式必须真连一次（SELECT 1），失败返回 503，让负载均衡/云托管把实例摘掉。
async function dbProbe(): Promise<"ok" | "error" | "n/a"> {
  if ((process.env.DATA_STORE || "memory") !== "postgres") return "n/a";
  try {
    const url = process.env.DATABASE_URL;
    if (!url) return "error";
    // 动态 import：memory 模式完全不加载 Prisma（探针按需加载）
    const { PrismaClient } = await import("@prisma/client");
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const client = new PrismaClient({ adapter: new PrismaPg(url) });
    try {
      await client.$queryRaw`SELECT 1`;
      return "ok";
    } finally {
      await client.$disconnect();
    }
  } catch (e) {
    console.error(`[health] 数据库探活失败: ${(e as Error)?.message ?? e}`);
    return "error";
  }
}

export async function GET() {
  const db = await dbProbe();
  const healthy = db !== "error";

  return NextResponse.json(
    {
      status: healthy ? "ok" : "error",
      uptimeSec: Math.round(process.uptime()),
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      amapMode: process.env.AMAP_WEB_SERVICE_KEY ? "live" : "mock",
      authProvider: process.env.AUTH_PROVIDER || "none",
      store: process.env.DATA_STORE || "memory",
      // n/a = 内存模式（无可探活的库）；ok/error = postgres 探活结果
      db,
    },
    { status: healthy ? 200 : 503 },
  );
}
