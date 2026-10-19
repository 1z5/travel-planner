import { NextRequest, NextResponse } from "next/server";
import { resolvePlan } from "@/lib/plan-repo";
import { buildIcs } from "@/lib/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/plan/ics?id=<share token 或旧 jobId> —— 行程日历订阅文件
//
// id 走 resolvePlan：优先持久化 Plan（分享链接长期可用），旧 job 链接在任务
// 2 小时 TTL 内仍可导出（向后兼容）。这条不用登录态，凭不可猜测 token 访问。
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const plan = await resolvePlan(id);
  if (!plan) {
    return NextResponse.json({ error: "行程不存在或已失效" }, { status: 404 });
  }
  const ics = buildIcs(plan);
  const filename = encodeURIComponent(`${plan.city}${plan.days.length}天行程.ics`);
  return new NextResponse(ics, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
    },
  });
}
