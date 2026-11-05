import { NextRequest, NextResponse } from "next/server";
import { resolvePlan } from "@/lib/plan-repo";
import { buildIcs } from "@/lib/ics";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/ics?id=<share token 或旧 jobId> —— 行程日历文件（可下载，也可订阅）
//
// id 走 resolvePlan：优先持久化 Plan（分享链接长期可用），旧 job 链接在任务
// 2 小时 TTL 内仍可导出（向后兼容）。这条不用登录态，凭不可猜测 token 访问。
//
// 两种取用方式（为什么用 query 区分而不是拆两个路由）：
// - 默认（缺省）：Content-Disposition: attachment —— 手机上表现为「下载一个
//   .ics」，导入即一份快照。行为与历史版本一致，桌面/一次性用户首选。
// - ?mode=subscribe：inline + 同一 URL 可被日历客户端（webcal:// 订阅）周期性
//   重新拉取，行程被改/重排后日历跟着更新——这是「行中值班」能落在系统日历
//   而不是一次性快照的关键。共用同一份限流与 resolvePlan 逻辑，少一处可漂移
//   的安全口径；代价是两种模式共用同一个小时桶配额。
//
// 安全审计 R3/R12：
// - 按 IP 小时桶限流（ICS_HOURLY_LIMIT，默认 60）：这是把 token 换成完整行程
//   内容的读取通道，和 status 一样需要防批量试探。订阅模式下客户端按
//   X-PUBLISHED-TTL（1 小时）刷新，多设备叠加也远低于 60。
// - Cache-Control: private, no-store：.ics 是私有工件（含逐日行程），不能被中间
//   缓存/共享设备留存；之前完全没缓存头，属于口径不一致。no-store 不影响
//   日历客户端自己持有副本，只是不让中间层存。
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
  const subscribe = req.nextUrl.searchParams.get("mode") === "subscribe";
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
      // 只有 attachment 才会触发「下载/导入」；inline 时浏览器可能直接渲染
      // 文本，所以订阅链接在前端一律以 webcal:// 形式给，让系统日历去认领
      "Content-Disposition": `${subscribe ? "inline" : "attachment"}; filename*=UTF-8''${filename}`,
      ...NO_STORE,
    },
  });
}
