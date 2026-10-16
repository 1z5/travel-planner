import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { reverseGeocode } from "@/lib/amap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/geocode/reverse?lng=116.48&lat=39.99
// 实时定位用：浏览器拿到坐标后，由服务端调高德逆地理编码换成城市名。
// 走服务端而不是前端直连高德，是为了不把 AMAP key 暴露给浏览器。

const QuerySchema = z.object({
  lng: z.coerce.number().min(-180).max(180),
  lat: z.coerce.number().min(-90).max(90),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({
    lng: req.nextUrl.searchParams.get("lng"),
    lat: req.nextUrl.searchParams.get("lat"),
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "坐标格式不正确" }, { status: 400 });
  }

  const geo = await reverseGeocode(parsed.data.lng, parsed.data.lat);
  if (!geo) {
    // 两种情况共用此文案：没配高德 key（MOCK 模式）、或坐标无法归属到城市。
    // 对用户的动作是一样的——手动输入城市，所以不必区分。
    return NextResponse.json(
      { error: "无法确定当前位置所在的城市，请手动输入" },
      { status: 422 },
    );
  }
  return NextResponse.json(geo);
}
