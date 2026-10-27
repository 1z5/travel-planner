import { NextResponse } from "next/server";
import { isProductionAuthMisconfigured, resolveAuthProviderId } from "@/lib/auth/guards";
import { capacitySnapshot } from "@/lib/capacity-gate";

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
  // 生产误配时登录链路是关闭的（见 lib/auth/providers.ts 的 DisabledProvider）。
  // 直接回显 env 原值会让运维以为「还在用 none 开发登录」，与真实行为不一致。
  const authProvider = isProductionAuthMisconfigured() ? "disabled" : resolveAuthProviderId();

  return NextResponse.json(
    {
      status: healthy ? "ok" : "error",
      uptimeSec: Math.round(process.uptime()),
      llmConfigured: Boolean(process.env.LLM_API_KEY),
      amapMode: process.env.AMAP_WEB_SERVICE_KEY ? "live" : "mock",
      authProvider,
      // 部署自证：Render 会注入 RENDER_GIT_COMMIT。之前「线上是不是最新版」只能
      // 靠猜（本轮 /pricing 404 时无法判断是部署未完成还是构建失败），把 commit
      // 暴露出来（只读、不含敏感信息）就能一眼确认线上跑的是哪个提交。
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      store: process.env.DATA_STORE || "memory",
      // n/a = 内存模式（无可探活的库）；ok/error = postgres 探活结果
      db,
      // 容量闸门快照（审计 P0-3）：运维能直接看到「现在有几个生成在跑、
      // 今日已用多少全站预算」，不用翻日志。不含任何用户数据。
      capacity: capacitySnapshot(),
    },
    { status: healthy ? 200 : 503 },
  );
}
