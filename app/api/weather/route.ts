import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { fetchWeather } from "@/lib/weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/weather?city=成都
// 旅途中重查天气：行程是出发前按预报排的，当天天气可能变了。前端在「行中」
// 场景由用户主动点击才拉取（不 on-load 打高德——见 PlanView 的 checkWeather）。
//
// 设计要点（与 suggest/geocode 一致）：
// - 高德 key 留在服务端，client 只调本端点（代理模式）
// - 三态返回，不猜：ok=有预报 / unavailable=查不到（MOCK 无 key / 超出预报窗口 /
//   上游异常）。查不到就明说，不编造天气
const QuerySchema = z.object({
  city: z
    .string()
    .trim()
    .regex(/^[\u4e00-\u9fa5A-Za-z·\s]{2,20}$/, "城市名格式不正确"),
});

export async function GET(req: NextRequest) {
  const parsed = QuerySchema.safeParse({
    city: req.nextUrl.searchParams.get("city"),
  });
  if (!parsed.success) {
    return NextResponse.json({ state: "unavailable", reason: "城市名格式不正确" }, { status: 400 });
  }

  const result = await fetchWeather(parsed.data.city);
  return NextResponse.json(result);
}
