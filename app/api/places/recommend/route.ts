import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recommendSights } from "@/lib/grounding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/places/recommend?city=西安
// 必游地推荐：城市热门景点（高德真实 POI，按评分排序）。
//
// 设计口径：
// - 只在用户已填目的地城市后由前端调用；MOCK 模式/上游异常返回空数组，
//   前端**整块不渲染**——补全是增强，不是门槛，也不拿假数据充数。
// - 名称直接来自高德：用户点选即入库，避免手打简称导致模型排不进去、
//   触发纠正重试把生成时间翻倍（实测 204s → 424s）。

const QuerySchema = z.object({
  city: z.string().trim().min(2).max(20),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({ city: req.nextUrl.searchParams.get("city") });
  if (!parsed.success) {
    return NextResponse.json({ sights: [] }, { status: 400 });
  }
  const sights = await recommendSights(parsed.data.city);
  return NextResponse.json({ sights });
}
