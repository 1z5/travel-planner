import "server-only";

// 高德 Web 服务：POI 验真 + 站点间通勤估算。
// 未配置 key 时进入 MOCK 模式：链路可跑通，但不做真实验真（plan.verified=false）。
//
// 2026-10 按官方文档校正：
// - POI 搜索：GET /v3/place/text（keywords + city + citylimit），pois[0].location 为 "lng,lat"
// - 通勤距离：GET /v5/direction/driving（origin/destination 只收经纬度坐标！v3/distance 已不在文档内）
//   因此 transitMinutes 必须先把地名经 verifyPoi 解析成坐标，否则真实模式下全部落 fallback

const KEY = process.env.AMAP_WEB_SERVICE_KEY;
const BASE = process.env.AMAP_BASE_URL || "https://restapi.amap.com";
export const AMAP_MOCK = !KEY;

export interface PoiInfo {
  name: string;
  address: string;
  location: string; // "经度,纬度"
  adname: string;   // 所在区
  verified: boolean;
}

// ---- 进程内缓存：同一 POI 会被「验真」和「多次通勤」重复用到，
// 个人 key 有 QPS/日配额，缓存既省调用又保证同一行程内结果一致 ----
const CACHE_TTL_MS = 30 * 60_000;
const poiCache = new Map<string, { t: number; v: PoiInfo | null }>();

async function amapGet(path: string, params: Record<string, string>) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

// 简单稳定的伪随机（mock 模式用，保证同一输入结果一致）
function hash(str: string): number {
  let h = 0;
  for (const c of str) h = (h * 31 + c.codePointAt(0)!) | 0;
  return Math.abs(h);
}

// POI 验真：在高德里按「城市 + 名称」搜，搜到才算真实存在
export async function verifyPoi(city: string, name: string): Promise<PoiInfo | null> {
  if (AMAP_MOCK) {
    const h = hash(city + name);
    return {
      name,
      address: `${city}·${name} 附近（mock）`,
      location: `${(104 + (h % 100) / 100).toFixed(6)},${(30 + (h % 97) / 100).toFixed(6)}`,
      adname: "mock",
      verified: false,
    };
  }

  const cacheKey = `${city}|${name}`;
  const hit = poiCache.get(cacheKey);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;

  const data = await amapGet("/v3/place/text", {
    keywords: name,
    city,
    citylimit: "true",
    offset: "1",
    extensions: "base",
  });
  const poi = data?.status === "1" && data.pois?.length ? data.pois[0] : null;
  const info: PoiInfo | null = poi
    ? {
        name: poi.name,
        address: typeof poi.address === "string" ? poi.address : "",
        location: poi.location,
        adname: poi.adname,
        verified: true,
      }
    : null;
  poiCache.set(cacheKey, { t: Date.now(), v: info });
  return info;
}

// 站点间通勤分钟数估算。
// 用驾车道路距离作为「距离代理」，按市内综合均速（地铁+步行约 22km/h）
// 折算，再加 8 分钟寻路/换乘缓冲——不是真实公交地铁路线，见 README 取舍。
export async function transitMinutes(
  city: string,
  from: string,
  to: string,
): Promise<number> {
  if (AMAP_MOCK) {
    return 15 + (hash(city + from + to) % 30); // 15~44 分钟
  }

  // 关键：距离接口只收坐标，先把两个地名解析成坐标
  const a = await verifyPoi(city, from);
  const b = await verifyPoi(city, to);
  if (!a || !b) return 30; // 地名解析失败给保守值

  const data = await amapGet("/v5/direction/driving", {
    origin: a.location,
    destination: b.location,
  });
  const meters = Number(data?.route?.paths?.[0]?.distance);
  if (!Number.isFinite(meters) || meters <= 0) return 30; // 查不到给保守值
  return Math.round(meters / 1000 / 22 * 60 + 8);
}
