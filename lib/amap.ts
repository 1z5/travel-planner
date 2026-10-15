import "server-only";
import { sleep } from "./concurrency";

// 高德 Web 服务：POI 验真 + 站点间通勤估算。
// 未配置 key 时进入 MOCK 模式：链路可跑通，但不做真实验证（plan.verified=false）。
//
// 2026-10 按官方文档校正：
// - POI 搜索：GET /v3/place/text（keywords + city + citylimit），pois[0].location 为 "lng,lat"
// - 通勤距离：GET /v5/direction/driving（origin/destination 只收经纬度坐标！v3/distance 已不在文档内）
//   因此 transitMinutes 必须先把地名经 lookupPoi 解析成坐标，否则真实模式下全部落 fallback
//
// 2026-10 健壮化（关键）：
// 原来的实现把「网络异常 / 上游错误码」和「高德明确说没有这个 POI」混为一谈
// （都返回 null），结果是 key 失效或 QPS 超限时，体检会把一堆真实存在的景点
// 标成「未在高德检索到」——预警系统自己变成谎言，正是本项目最怕的事故。
// 现在返回三态，error 态绝不产生「未检索到」预警，只汇总成系统提示。

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

/** POI 查询三态：hit=命中 / miss=高德明确无结果 / error=网络或上游异常（≠不存在） */
export type PoiLookup =
  | { state: "hit"; poi: PoiInfo }
  | { state: "miss" }
  | { state: "error"; reason: string };

/** 通勤估算两态：unknown 时调用方必须跳过该天的通勤/节奏判定，不能拿假数据填 */
export type TransitResult =
  | { state: "ok"; minutes: number }
  | { state: "unknown"; reason: string };

// ---- 缓存：同一 POI 会被「验真」和「多次通勤」重复用到（住所每天都出现），
// 个人 key 有 QPS/日配额，缓存既省调用又保证同一行程内结果一致。
// error 也缓存但 TTL 很短：高德整体抖动时，一次体检里同一地名会被反复
// 解析，不缓存等于把已经挂掉的服务再打几十遍；10 秒覆盖一次体检，
// 又不妨碍快速恢复。设总量上限防长驻进程无限增长 ----
const CACHE_TTL_MS = 30 * 60_000;
const ERROR_CACHE_TTL_MS = 10_000;
const CACHE_MAX = 500;
const poiCache = new Map<string, { t: number; v: PoiLookup }>();

function ttlFor(v: PoiLookup): number {
  return v.state === "error" ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
}

// ---- 在飞去重：并行验真时同一地名会被多个任务同时请求（如每天的住所），
// 共享同一个 Promise，避免重复打高德 ----
const inflight = new Map<string, Promise<PoiLookup>>();

// ---- 瞬时失败重试：网络异常 + QPS/频率类上游错误。
// key 无效、平台不匹配这类重试无意义，直接进入 error 态 ----
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [150, 400];
const FETCH_TIMEOUT_MS = 10_000;
// 高德 infocode 里属于「稍后重试即可」的：QPS/频率/日配额类
const TRANSIENT_INFOCODES = new Set(["10003", "10004", "10019", "10020", "10021", "10022"]);

function isTransientUpstream(info: string, infocode: string): boolean {
  if (TRANSIENT_INFOCODES.has(infocode)) return true;
  return /QPS|LIMIT|FREQUEN|BUSY|RETRY|频率|超出|并发|繁忙/i.test(info);
}

// 简单稳定的伪随机（mock 模式用，保证同一输入结果一致）
function hash(str: string): number {
  let h = 0;
  for (const c of str) h = (h * 31 + c.codePointAt(0)!) | 0;
  return Math.abs(h);
}

// ---- 日志去重：key 失效时 25 个 POI × 3 次尝试会刷 75 条同样的错，
// 按内容在 60 秒窗口内只记一次 ----
const lastLogged = new Map<string, number>();
function logOnce(msg: string, windowMs = 60_000): void {
  const now = Date.now();
  const prev = lastLogged.get(msg);
  if (prev !== undefined && now - prev < windowMs) return;
  if (lastLogged.size > 100) lastLogged.clear();
  lastLogged.set(msg, now);
  console.warn(msg);
}

type AmapResult =
  | { ok: true; data: unknown }
  | { ok: false; kind: "http" | "network" | "upstream"; detail: string; transient: boolean };

async function amapGet(path: string, params: Record<string, string>): Promise<AmapResult> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("key", KEY!);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        kind: "http",
        detail: `HTTP ${res.status}`,
        transient: res.status >= 500 || res.status === 429,
      };
    }
    if (data?.status !== "1") {
      const info = String(data?.info ?? "未知错误");
      const infocode = String(data?.infocode ?? "");
      const transient = isTransientUpstream(info, infocode);
      // 非瞬时错误（典型：key 类型选错/未生效）必须响一次，否则它只会表现为
      // 「一堆景点未能验真」，没人知道根因是配置
      if (!transient) {
        logOnce(`[amap] 上游拒绝请求 ${path} infocode=${infocode} info=${info}——相关地点将标记为「未能验真」而非「未检索到」`);
      }
      return { ok: false, kind: "upstream", detail: `${infocode} ${info}`, transient };
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, kind: "network", detail: (e as Error).message, transient: true };
  }
}

/** 带退避重试的请求：只在 transient 失败时重试 */
async function amapGetRetry(path: string, params: Record<string, string>): Promise<AmapResult> {
  let last: AmapResult = { ok: false, kind: "network", detail: "未发起请求", transient: false };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(BACKOFF_MS[attempt - 2]);
    last = await amapGet(path, params);
    if (last.ok || !last.transient) return last;
    logOnce(`[amap] ${path} 第 ${attempt}/${MAX_ATTEMPTS} 次失败（${last.detail}），将重试`);
  }
  return last;
}

function cacheSet(key: string, v: PoiLookup): void {
  if (poiCache.size >= CACHE_MAX && !poiCache.has(key)) {
    const oldest = poiCache.keys().next().value; // Map 迭代序即插入序，淘汰最旧
    if (oldest !== undefined) poiCache.delete(oldest);
  }
  poiCache.set(key, { t: Date.now(), v });
}

/**
 * POI 验真：在高德里按「城市 + 名称」搜。
 * 三态语义见 PoiLookup——error 表示「不知道」，调用方不得据此下任何结论。
 */
export async function lookupPoi(city: string, name: string): Promise<PoiLookup> {
  if (AMAP_MOCK) {
    const h = hash(city + name);
    return {
      state: "hit",
      poi: {
        name,
        address: `${city}·${name} 附近（mock）`,
        location: `${(104 + (h % 100) / 100).toFixed(6)},${(30 + (h % 97) / 100).toFixed(6)}`,
        adname: "mock",
        verified: false,
      },
    };
  }

  const cacheKey = `${city}|${name}`;
  const hit = poiCache.get(cacheKey);
  if (hit && Date.now() - hit.t < ttlFor(hit.v)) return hit.v;

  const running = inflight.get(cacheKey);
  if (running) return running;

  const task = (async (): Promise<PoiLookup> => {
    const r = await amapGetRetry("/v3/place/text", {
      keywords: name,
      city,
      citylimit: "true",
      offset: "1",
      extensions: "base",
    });
    let lookup: PoiLookup;
    if (!r.ok) {
      lookup = { state: "error", reason: r.detail };
    } else {
      const data = r.data as { pois?: Array<Record<string, unknown>> };
      const poi = data.pois?.length ? data.pois[0] : null;
      lookup = poi
        ? {
            state: "hit",
            poi: {
              name: String(poi.name ?? name),
              address: typeof poi.address === "string" ? poi.address : "",
              location: String(poi.location ?? ""),
              adname: String(poi.adname ?? ""),
              verified: true,
            },
          }
        : { state: "miss" };
    }
    cacheSet(cacheKey, lookup); // error 也进缓存（短 TTL，见 ttlFor）
    return lookup;
  })();

  inflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cacheKey);
  }
}

/**
 * 站点间通勤分钟数估算。
 * 用驾车道路距离作为「距离代理」，按市内综合均速（地铁+步行约 22km/h）
 * 折算，再加 8 分钟寻路/换乘缓冲——不是真实公交地铁路线，见 README 取舍。
 *
 * 地名解析失败（miss）沿用既有的 30 分钟保守值；但网络/上游异常必须返回
 * unknown：拿一个拍脑袋数字去参与「绕路预警」和「节奏体检」会污染两个指标。
 */
export async function transitMinutes(
  city: string,
  from: string,
  to: string,
): Promise<TransitResult> {
  if (AMAP_MOCK) {
    return { state: "ok", minutes: 15 + (hash(city + from + to) % 30) }; // 15~44 分钟
  }

  // 关键：距离接口只收坐标，先把两个地名解析成坐标
  const a = await lookupPoi(city, from);
  const b = await lookupPoi(city, to);
  if (a.state === "error") return { state: "unknown", reason: `「${from}」解析失败：${a.reason}` };
  if (b.state === "error") return { state: "unknown", reason: `「${to}」解析失败：${b.reason}` };
  if (a.state === "miss" || b.state === "miss") return { state: "ok", minutes: 30 };

  const r = await amapGetRetry("/v5/direction/driving", {
    origin: a.poi.location,
    destination: b.poi.location,
  });
  if (!r.ok) return { state: "unknown", reason: r.detail };

  const meters = Number((r.data as { route?: { paths?: Array<{ distance?: string }> } })?.route?.paths?.[0]?.distance);
  if (!Number.isFinite(meters) || meters <= 0) {
    return { state: "unknown", reason: "距离接口未返回有效数据" };
  }
  return { state: "ok", minutes: Math.round(meters / 1000 / 22 * 60 + 8) };
}
