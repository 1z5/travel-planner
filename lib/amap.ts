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
// 静态地图（/v3/staticmap）返回二进制而非 JSON，无法复用 amapGetRetry；
// 但 key/base 必须与上面的 JSON 请求保持同一份配置（尤其 e2e 用
// AMAP_BASE_URL 指向桩服务）。只做最小导出，不改任何现有逻辑。
export const AMAP_KEY = KEY;
export const AMAP_BASE = BASE;

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
// 单段通勤的距离合理性上限（米）。超过即认为 POI 匹配错误（典型：境外地名
// 被匹配到国内同名 POI），返回 unknown 让调用方跳过该天判定，避免输出
// 「98 小时通勤」这类荒唐预警。详见 transitMinutes 里的实测说明。
const MAX_TRANSIT_METERS = 150_000;
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
// 退避分两类，因为两类失败的「恢复时间尺度」完全不同：
// - 网络异常（连接重置 / fetch failed）：通常瞬时恢复，短退避足够
// - 上游限流（QPS/频率类）：高德的 QPS 是**秒级窗口**，150ms/400ms 的
//   重试全落在同一秒内，几乎必然再次超限。真机日志实测：driving 接口
//   3 次重试全失败，导致当天通勤估算失败、节奏体检被跳过。必须退避到
//   跨过秒级窗口（≥1s），否则重试只是把失败重复三遍。
const BACKOFF_NETWORK_MS = [150, 400];
const BACKOFF_RATELIMIT_MS = [1000, 2000];
const FETCH_TIMEOUT_MS = 10_000;
// 高德 infocode 里属于「稍后重试即可」的：QPS/频率/日配额类
const TRANSIENT_INFOCODES = new Set(["10003", "10004", "10019", "10020", "10021", "10022"]);

// 导出给 staticmap.ts 复用：静态地图接口的限流错误（HTTP 200 + JSON body）
// 与这里的判定口径必须一致，否则会重试不该重试的错误、或漏掉 QPS 退避。
export function isTransientUpstream(info: string, infocode: string): boolean {
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

/**
 * 带退避重试的请求：只在 transient 失败时重试。导出供 weather.ts 复用。
 *
 * 退避按「上一次失败的原因」选择：限流类（QPS/频率/HTTP 429）必须跨过
 * 秒级窗口才重试，否则三次尝试全落在同一秒内、必然连续超限；网络异常
 * 用短退避（通常是瞬时恢复，等 1 秒反而拖慢）。
 */
export async function amapGetRetry(path: string, params: Record<string, string>): Promise<AmapResult> {
  let last: AmapResult = { ok: false, kind: "network", detail: "未发起请求", transient: false };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const backoff =
        last.kind === "upstream" || /HTTP 429/.test(last.detail)
          ? BACKOFF_RATELIMIT_MS
          : BACKOFF_NETWORK_MS;
      await sleep(backoff[attempt - 2]);
    }
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
 *
 * scope=region 时**不带 citylimit**：区域的 POI 分散在多个行政区
 * （川西环线跨成都/阿坝/甘孜），而高德不认识「川西环线」这个 city，
 * 带 citylimit 会把结果全部滤空。放开后按关键词搜，靠 miss/error
 * 三态与 transitMinutes 的距离上限兜底误匹配。
 */
export async function lookupPoi(
  city: string,
  name: string,
  scope: "city" | "region" = "city",
): Promise<PoiLookup> {
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

  const cacheKey = `${city}|${scope}|${name}`;
  const hit = poiCache.get(cacheKey);
  if (hit && Date.now() - hit.t < ttlFor(hit.v)) return hit.v;

  const running = inflight.get(cacheKey);
  if (running) return running;

  const task = (async (): Promise<PoiLookup> => {
    // 区域模式不传 city/citylimit：高德按关键词全局搜，否则会被
    // 「川西环线」这个不存在的 city 滤成空结果
    const params: Record<string, string> = {
      keywords: name,
      offset: "1",
      extensions: "base",
    };
    if (scope === "city") {
      params.city = city;
      params.citylimit = "true";
    }
    const r = await amapGetRetry("/v3/place/text", params);
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
  scope: "city" | "region" = "city",
): Promise<TransitResult> {
  if (AMAP_MOCK) {
    return { state: "ok", minutes: 15 + (hash(city + from + to) % 30) }; // 15~44 分钟
  }

  // 关键：距离接口只收坐标，先把两个地名解析成坐标
  const a = await lookupPoi(city, from, scope);
  const b = await lookupPoi(city, to, scope);
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
  // 距离合理性上限：超过视为 POI 匹配错误，返回 unknown（让调用方跳过该天
  // 的判定）而不是硬算一个荒谬值。
  //
  // 实测踩过：高德对**境外地名**会误匹配到国内同名 POI——「清水寺」返回的是
  // 山西坐标（114.5E,37.0N）而非京都（135.8E,35.0N），于是「京都市内通勤」
  // 用两个山西坐标算出 2000+ 公里 → 98 小时的荒唐预警，节奏判定跟着全崩。
  //
  // 阈值 150km：合法的跨城当日游（成都→都江津 ~60km、北京→天津 ~120km）
  // 都覆盖得到；而 150km 折算约 7 小时车程，本就远超城市行程的合理范围。
  if (meters > MAX_TRANSIT_METERS) {
    return {
      state: "unknown",
      reason: `站点间距离 ${Math.round(meters / 1000)}km 超出合理范围，POI 可能匹配到了同名的其他城市`,
    };
  }
  return { state: "ok", minutes: Math.round(meters / 1000 / 22 * 60 + 8) };
}

/**
 * 从逆地理编码的 addressComponent 里提取城市裸名（无「市」后缀）。
 *
 * 两个实测坑（真实高德 key 验证过）：
 * 1. **直辖市的 city 是空数组**——北京/上海/天津/重庆的 city 与 province
 *    被高德合一，实测天安门坐标返回 `city: []`、`province: "北京市"`。
 *    直接取 city 会得到空字符串，必须回退 province。
 * 2. 普通城市的 city 带「市」后缀（"成都市"），而应用内城市名约定是裸名
 *    （CITY_IMAGES 的键、快捷选择 chip 都是「成都」「北京」），必须剥离。
 *
 * 已知局限：自治区会得到「广西壮族」这类名字（只剥了「自治区」没剥民族名），
 * 极少见且不影响主流程，接受。
 */
export function pickCityName(ac: { city?: unknown; province?: unknown }): string | null {
  const norm = (v: unknown): string => {
    if (Array.isArray(v)) return ""; // 直辖市的 city 是 []
    const s = String(v ?? "").trim();
    // 剥掉行政级别后缀留裸名：「成都市」→「成都」、「北京市」→「北京」
    return s.replace(/(省|市|自治区|自治州|地区|盟|县)$/, "") || s;
  };
  const city = norm(ac.city);
  if (city) return city;
  const province = norm(ac.province);
  return province || null;
}

/** 逆地理编码结果 */
export interface ReverseGeo {
  city: string;      // 城市裸名（已归一化，如「北京」「成都」）
  district: string;  // 区县（如「朝阳区」），仅用于展示
  formatted: string; // 完整地址（如「北京市朝阳区望京街道…」），仅用于展示
}

/**
 * 逆地理编码：坐标 → 城市。失败返回 null，由调用方降级为手动输入城市。
 *
 * MOCK 模式（未配 key）直接返回 null——定位功能依赖高德，没有 key 时
 * 不应假装能用；前端会提示手动输入。
 */
export async function reverseGeocode(lng: number, lat: number): Promise<ReverseGeo | null> {
  if (AMAP_MOCK) return null;

  const r = await amapGetRetry("/v3/geocode/regeo", {
    location: `${lng},${lat}`,
    extensions: "base",
  });
  if (!r.ok) return null;

  const regeo = (r.data as {
    regeocode?: {
      addressComponent?: { city?: unknown; province?: unknown; district?: unknown };
      formatted_address?: unknown;
    };
  })?.regeocode;
  const city = pickCityName(regeo?.addressComponent ?? {});
  if (!city) return null;

  return {
    city,
    district: String(regeo?.addressComponent?.district ?? ""),
    formatted: String(regeo?.formatted_address ?? ""),
  };
}

// ============================================================
// 地点建议（地址输入自动补全）。
//
// 与 lookupPoi 的分工：lookupPoi 验真「这一个名字存不存在」（单发、三态），
// suggestPlaces 回答「用户输入的字前缀对应哪些真实地点」（多发、给下拉用）。
// 两者都走 /v3/place/text，但返回条数与用途不同。
//
// 产品动机：地址字段原本是自由填写，用户打错一个字（「武侯祠」→「武候祠」）
// 就会让 POI 验真失败、行程质量下降。补全把输入约束在真实地点内，
// 且不需要额外 key——复用已有的 Web 服务 key。
// ============================================================

/** 一条地点建议 */
export interface PlaceSuggestion {
  name: string;      // 地点名（填入输入框的值）
  detail: string;    // 附属说明（区县/地址），展示用
  city: string;      // 所属城市（裸名，如「成都」）——城市字段据此判断是否城市级
  isCity: boolean;   // 是否为城市级结果（决定建议归属「城市」还是「具体地点」）
}

/** 建议查询结果。error 时返回空列表而非抛错——补全失败应降级为自由输入 */
export interface SuggestResult {
  suggestions: PlaceSuggestion[];
  /** 失败原因（仅用于日志；前端不展示，避免把技术问题暴露给用户） */
  error?: string;
}

/**
 * 按关键词查地点建议。
 *
 * @param scope city    —— 城市字段用：优先返回城市级结果（「成都」→「成都市」）
 *              poi     —— 住所/必游地用：返回具体地点（酒店/景点）
 * @param city  可选，收窄到某城市内（POI 模式建议传，避免全国重名干扰）
 */
export async function suggestPlaces(
  keywords: string,
  scope: "city" | "poi" = "poi",
  city?: string,
): Promise<SuggestResult> {
  const q = keywords.trim();
  if (q.length < 1) return { suggestions: [] };
  if (AMAP_MOCK) return { suggestions: [], error: "未配置高德 key（MOCK 模式）" };

  const params: Record<string, string> = {
    keywords: q,
    offset: "8", // 一次多取一些，前端过滤后仍够 5 条
    extensions: "base",
  };
  // 城市模式不限定 city——否则搜「成都」时被 citylimit 框住反而找不到城市本身
  if (scope === "poi" && city) {
    params.city = city;
    params.citylimit = "true";
  }

  const r = await amapGetRetry("/v3/place/text", params);
  if (!r.ok) return { suggestions: [], error: r.detail };

  const pois = (r.data as { pois?: Array<Record<string, unknown>> })?.pois ?? [];
  const suggestions: PlaceSuggestion[] = [];
  const seen = new Set<string>();

  for (const p of pois) {
    const name = String(p.name ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const rawCity = String(p.city ?? p.pname ?? "");
    const cityName = pickCityName({ city: rawCity, province: String(p.pname ?? "") }) || "";
    const isCity = scope === "city" && (name === cityName || name.replace(/市$/, "") === cityName);
    const detail = [p.adname, p.address].filter((x) => typeof x === "string" && x).join(" · ");

    suggestions.push({ name, detail: String(detail), city: cityName, isCity });
    if (suggestions.length >= 5) break;
  }

  // 城市模式：把城市级结果提到最前（用户搜「成都」时「成都市」应排第一）
  if (scope === "city") {
    suggestions.sort((a, b) => Number(b.isCity) - Number(a.isCity));
  }
  return { suggestions };
}
