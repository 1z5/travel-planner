import { NextRequest, NextResponse } from "next/server";
import { fitView, parseLocText } from "@/lib/map-view";
import { fetchStaticMap, staticMapEnabled } from "@/lib/staticmap";

export const runtime = "nodejs";
// 地图随中心/zoom/站点变化，必须每次按参数生成（不能静态化）
export const dynamic = "force-dynamic";

// GET /api/map?loc=lng,lat;lng,lat;...&w=720&h=400&scale=2
//
// 真实地图底图代理：把每天行程的站点坐标交给高德静态地图，返回 PNG。
// 路线连线/编号标记由前端 components/RealMap.tsx 用同一套 Web Mercator
// 数学自绘覆盖层（高德 paths 参数在本项目 key 上不可用，见 lib/staticmap.ts）。
//
// 错误契约（前端依赖它做降级，不能返回 200 非图片）：
// - 参数非法 → 400 JSON
// - 无 key / AMAP_MAP_DISABLED=1 → 503 JSON { error:"地图未配置" }
// - 上游失败 → 502 JSON（前端 <img> onError 后降级为示意图）
const MAX_POINTS = 10;
const MIN_WIDTH = 320;
const MAX_WIDTH = 1024;
const MIN_HEIGHT = 200;
const MAX_HEIGHT = 640;
const DEFAULT_WIDTH = 720;
const DEFAULT_HEIGHT = 400;

/** 解析并夹取尺寸参数：容忍超大/超小值（夹到合法区间），非数字才报错 */
function parseDimension(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(min, Math.min(max, n)));
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;

  // 1) loc：1-10 个合法坐标（分号分隔）。与 RealMap 的请求格式一一对应
  const rawLoc = (sp.get("loc") ?? "").trim();
  if (!rawLoc) {
    return NextResponse.json({ error: "缺少 loc 参数（格式 lng,lat;lng,lat）" }, { status: 400 });
  }
  const segments = rawLoc
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 1 || segments.length > MAX_POINTS) {
    return NextResponse.json(
      { error: `loc 需要 1-${MAX_POINTS} 个坐标点，收到 ${segments.length} 个` },
      { status: 400 },
    );
  }
  const points = [];
  for (const seg of segments) {
    const p = parseLocText(seg);
    if (!p) {
      return NextResponse.json(
        { error: `坐标格式非法：${seg}（应为「经度,纬度」，经度 ±180、纬度 ±85 内）` },
        { status: 400 },
      );
    }
    points.push(p);
  }

  // 2) w/h：夹取到 [320,1024] / [200,640]；比例不强求（调用方自己决定观感）
  const w = parseDimension(sp.get("w"), DEFAULT_WIDTH, MIN_WIDTH, MAX_WIDTH);
  const h = parseDimension(sp.get("h"), DEFAULT_HEIGHT, MIN_HEIGHT, MAX_HEIGHT);
  if (w === null || h === null) {
    return NextResponse.json({ error: "w/h 必须是数字" }, { status: 400 });
  }

  // 3) scale 只允许 1|2（高德高清屏参数）
  const rawScale = sp.get("scale");
  const scale = rawScale === null || rawScale === "" ? 2 : Number(rawScale);
  if (scale !== 1 && scale !== 2) {
    return NextResponse.json({ error: "scale 只支持 1 或 2" }, { status: 400 });
  }

  // 4) 能力检查放参数校验之后：先告诉调用方是参数错了，再谈服务不可用
  if (!staticMapEnabled()) {
    return NextResponse.json({ error: "地图未配置" }, { status: 503 });
  }

  // 与服务端同一实现拟合视野——RealMap 用完全相同的参数算覆盖层坐标，
  // 两端若用不同 padding/实现，编号标记就会从底图真实位置漂走。
  const view = fitView(points, w, h);
  const result = await fetchStaticMap(view, w, h, scale === 1 ? 1 : 2);
  if (!result.ok) {
    // 只记日志，不把高德错误码透给前端（与 suggest/weather 的代理原则一致）
    console.log(`[map] 生成失败 loc=${rawLoc} w=${w} h=${h} scale=${scale}: ${result.reason}`);
    return NextResponse.json(
      { error: result.status === 503 ? "地图未配置" : "地图服务暂不可用，请稍后再试" },
      { status: result.status === 503 ? 503 : 502 },
    );
  }

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      // 静态底图地理数据几乎不变：浏览器/CDN 可放心缓存 7 天（服务端还有 LRU）
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
