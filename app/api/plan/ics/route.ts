import { NextRequest, NextResponse } from "next/server";
import { resolvePlan } from "@/lib/plan-repo";
import { buildIcs } from "@/lib/ics";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/ics?id=<share token 或旧 jobId> —— 行程日历订阅文件
//
// id 走 resolvePlan：优先持久化 Plan（分享链接长期可用），旧 job 链接在任务
// 2 小时 TTL 内仍可导出（向后兼容）。这条不用登录态，凭不可猜测 token 访问。
//
// 安全审计 R3/R12：
// - 按 IP 小时桶限流（ICS_HOURLY_LIMIT，默认 60）：这是把 token 换成完整行程
//   内容的读取通道，和 status 一样需要防批量试探；正常用户一天导几次，60 足够。
// - Cache-Control: private, no-store：.ics 是私有工件（含逐日行程），不能被中间
//   缓存/共享设备留存；之前完全没缓存头，属于口径不一致。
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: NextRequest) {
  const rl = await checkProxyRateLimit(req.headers, "plan-ics", "ICS_HOURLY_LIMIT", 60);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: `导出太频繁：每小时最多 ${rl.limit} 次，请稍后再试`, limit: rl.limit },
      { status: 429, headers: NO_STORE },
    );
  }

  const id = req.nextUrl.searchParams.get("id") ?? "";
  const plan = await resolvePlan(id);
  if (!plan) {
    return NextResponse.json({ error: "行程不存在或已失效" }, { status: 404, headers: NO_STORE });
  }
  const ics = buildIcs(plan);
  const filename = encodeURIComponent(`${plan.city}${plan.days.length}天行程.ics`);
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      ...NO_STORE,
    },
  });
}
