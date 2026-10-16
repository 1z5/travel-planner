import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { suggestPlaces } from "@/lib/amap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/places/suggest?q=成都&scope=city|poi&city=成都
// 地址输入自动补全。前端在用户输入时防抖调用，展示真实地点下拉。
//
// 设计要点：
// - 失败降级为「空建议」而不是报错——补全不可用时用户仍可自由输入，
//   补全是增强不是门槛（与定位/天气一致的原则）
// - scope 区分城市与 POI：城市字段要城市级结果，住所/必游地要具体地点

const QuerySchema = z.object({
  q: z.string().trim().min(1).max(40),
  scope: z.enum(["city", "poi"]).default("poi"),
  city: z.string().trim().max(20).optional(),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({
    q: req.nextUrl.searchParams.get("q"),
    scope: req.nextUrl.searchParams.get("scope") ?? undefined,
    city: req.nextUrl.searchParams.get("city") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ suggestions: [] }, { status: 400 });
  }

  const { q, scope, city } = parsed.data;
  const result = await suggestPlaces(q, scope, city);

  // 上游异常只进日志，不透出细节（避免把高德的错误码暴露给前端）
  if (result.error) {
    console.log(`[suggest] q=${q} scope=${scope} 失败: ${result.error}`);
  }
  return NextResponse.json({ suggestions: result.suggestions });
}
