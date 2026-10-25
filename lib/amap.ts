import "server-only";
import { sleep } from "./concurrency";
import { isTemporarilyClosedName } from "./poi-hours";
import type { PlanLeg, TransportMode } from "./types";

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
  adname: string; // 所在区
  verified: boolean;
  // 高德 type 原文（如 "风景名胜|公园广场"）。用于把 POI 归类成景点/餐饮——
  // 归类只看高德自己的分类字段，不靠名字猜。
  poiType?: string;
  // ---- 以下来自 extensions=all 的 biz_ext / POI 顶层字段，全部可选 ----
  // 语义与 PlanSpot.poi（SpotPoiMeta）一致：有数据才填，高德返回空数组 `[]`
  // 或缺字段时就是 undefined——不填 ≠ 0 分 / 24 小时营业这类默认值。
  rating?: number; // 高德评分（"4.8" → 4.8）
  avgCostCny?: number; // 高德人均消费（"65.00" → 65）
  openTime?: string; // open_time 原文（简版）
  openTime2?: string; // opentime2 原文（含闭馆规则/季节/最晚进入）
  tel?: string; // 联系电话（POI 顶层 tel 字段）
  temporarilyClosed?: boolean; // 名称含「暂停开放/暂停营业/已关闭」
}

/** POI 查询三态：hit=命中 / miss=高德明确无结果 / error=网络或上游异常（≠不存在） */
export type PoiLookup =
  { state: "hit"; poi: PoiInfo } | { state: "miss" } | { state: "error"; reason: string };

/** 候选检索入参 */
export interface PoiSearchOptions {
  city: string;
  keywords: string;
  scope?: "city" | "region";
  limit?: number;
}

/** 候选检索三态（语义与 PoiLookup 一致） */
export type PoiSearchResult =
  { state: "hit"; pois: PoiInfo[] } | { state: "miss" } | { state: "error"; reason: string };

/** 通勤估算两态：unknown 时调用方必须跳过该天的通勤/节奏判定，不能拿假数据填 */
export type TransitResult = { state: "ok"; minutes: number } | { state: "unknown"; reason: string };

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
// 候选检索单独缓存：关键词检索比单点验真更"宽"（同一城市多个品类关键词），
// 重复检索的代价一样高（个人 key 有 QPS），但缓存键与验真不同，不能混用。
const searchCache = new Map<string, { t: number; v: PoiSearchResult }>();

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
        logOnce(
          `[amap] 上游拒绝请求 ${path} infocode=${infocode} info=${info}——相关地点将标记为「未能验真」而非「未检索到」`,
        );
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
export async function amapGetRetry(
  path: string,
  params: Record<string, string>,
): Promise<AmapResult> {
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
 * biz_ext 字段归一化：高德同一字段可能是字符串、数字，也可能是空数组 `[]`
 * （表示「没有这项数据」）。只有拿到**有效值**才返回，空值/数组/对象一律 undefined
 * ——把 [] 当 0 分/0 元会凭空造出假数据，正是本项目最怕的事。
 */
function bizText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t || undefined;
  }
  if (Array.isArray(value)) {
    // 实测 opentime2 / open_time 偶有多段数组返回，用中文分号拼回原文语义
    const parts = value
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts.join("；") : undefined;
  }
  return undefined;
}

function bizNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined; // [] / {} 等：没有数据
}

/**
 * 从 extensions=all 的返回里提取 POI 详情（评分/人均/营业时间/电话/停业状态）。
 * 只填**拿得到**的字段：缺字段就不出现在对象里，上层（SpotPoiMeta）保持可选语义。
 */
function parsePoiDetails(poi: Record<string, unknown>, name: string): Partial<PoiInfo> {
  const rawExt = poi.biz_ext;
  // biz_ext 正常是对象，但没有详情时实测也可能给 []（空数组）
  const ext =
    rawExt && typeof rawExt === "object" && !Array.isArray(rawExt)
      ? (rawExt as Record<string, unknown>)
      : {};
  const details: Partial<PoiInfo> = {};
  const rating = bizNumber(ext.rating);
  if (rating !== undefined && rating > 0) details.rating = rating;
  const cost = bizNumber(ext.cost);
  if (cost !== undefined && cost >= 0) details.avgCostCny = cost;
  const openTime = bizText(ext.open_time);
  if (openTime) details.openTime = openTime;
  const openTime2 = bizText(ext.opentime2);
  if (openTime2) details.openTime2 = openTime2;
  const tel = bizText(poi.tel);
  if (tel) details.tel = tel;
  // 高德用名称表达停业状态（实测「金沙遗址博物馆(暂停开放)」）
  if (isTemporarilyClosedName(name)) details.temporarilyClosed = true;
  // 分类字段：归类景点/餐饮只看高德自己的 type，不靠名称猜
  const type = bizText(poi.type);
  if (type) details.poiType = type;
  return details;
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
    // 不填任何详情字段：未接高德时没有评分/营业时间的真实依据，填哈希假数据
    // 就是「假装验真过」——MOCK 模式下 verified=false，详情同样必须缺席。
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
      // extensions=all：本函数不只验真「有没有这个地方」，还要拿回评分/人均/
      // 营业时间（biz_ext.opentime2 等）供体检判断「到点开不开门」。
      // 三态语义/缓存/重试策略与 base 时完全一致，只有响应多带详情。
      extensions: "all",
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
              // 详情字段按实际返回填（缺字段就不出现）；三态/缓存对象随之变大，
              // 但 CACHE_MAX=500 的上限不变，缓存反而让后续体检零额外调用。
              ...parsePoiDetails(poi, String(poi.name ?? name)),
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
 * 候选检索：问「这个城市/区域里有哪些可用的景点和餐厅」，返回**列表**。
 *
 * 为什么与 lookupPoi 并存（两者不是一回事）：
 * - lookupPoi = 验真，问「这个名字存在吗」，取 top1，用于**生成之后**核对；
 * - searchPois = 取材，问「有哪些可选」，用于**生成之前**给模型一份真实清单。
 * 「事实先行」需要后者：模型手上必须有真实存在、营业时间已核验的地点，
 * 才能排出天生可执行的行程，而不是先编再验。
 *
 * 三态语义与 lookupPoi 完全一致：miss=高德明确无结果；error=网络/上游异常
 * （**不等于**不存在，调用方不得据此下任何结论）。
 *
 * MOCK 模式返回 error 而不是编造候选：没有数据源时给出假清单，
 * 等于把「假装验真过」写进了生成过程。
 */
export async function searchPois(opts: PoiSearchOptions): Promise<PoiSearchResult> {
  const scope = opts.scope ?? "city";
  const limit = Math.max(1, Math.min(20, opts.limit ?? 10));
  if (AMAP_MOCK) {
    return { state: "error", reason: "MOCK 模式：未接入高德，无真实 POI 候选" };
  }

  const cacheKey = `${scope}|${opts.city}|${opts.keywords}|${limit}`;
  const cached = searchCache.get(cacheKey);
  if (cached) {
    const ttl = cached.v.state === "error" ? ERROR_CACHE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - cached.t < ttl) return cached.v;
  }

  const params: Record<string, string> = {
    keywords: opts.keywords,
    offset: "1",
    page_size: String(limit),
    // 与验真同一口径：候选也要带 biz_ext（营业时间/评分/人均），否则清单里
    // 只是一串名字，拿不到「事实先行」真正要的那部分。
    extensions: "all",
  };
  if (scope === "city") {
    params.city = opts.city;
    params.citylimit = "true";
  }

  const r = await amapGetRetry("/v3/place/text", params);
  let result: PoiSearchResult;
  if (!r.ok) {
    result = { state: "error", reason: r.detail };
  } else {
    const data = r.data as { pois?: Array<Record<string, unknown>> };
    const pois = (data.pois ?? []).slice(0, limit).map((poi) => ({
      name: String(poi.name ?? ""),
      address: typeof poi.address === "string" ? poi.address : "",
      location: String(poi.location ?? ""),
      adname: String(poi.adname ?? ""),
      verified: true,
      ...parsePoiDetails(poi, String(poi.name ?? "")),
    }));
    result = pois.length ? { state: "hit", pois } : { state: "miss" };
  }

  if (searchCache.size >= CACHE_MAX && !searchCache.has(cacheKey)) {
    const oldest = searchCache.keys().next().value; // Map 迭代序即插入序
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(cacheKey, { t: Date.now(), v: result });
  return result;
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

  const meters = Number(
    (r.data as { route?: { paths?: Array<{ distance?: string }> } })?.route?.paths?.[0]?.distance,
  );
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
  return { state: "ok", minutes: Math.round((meters / 1000 / 22) * 60 + 8) };
}

/** 分段路线结果：ok=算出了 / unknown=算不出（缺坐标/上游异常） */
export type RouteSegmentResult =
  | { state: "ok"; leg: Omit<PlanLeg, "from" | "to" | "mode"> }
  | { state: "unknown"; reason: string };

// 各方式的高德 v5 direction 端点。公交/地铁（transit/integrated）实测当前
// key 返回 HTTP 400（个人 Web 服务 key 未开放），故不提供。
// 只收三种具体方式：auto 在 routeSegment 里先解析成其中一种再查表
const DIRECTION_PATH: Record<"walking" | "bicycling" | "driving", string> = {
  walking: "/v5/direction/walking",
  bicycling: "/v5/direction/bicycling",
  driving: "/v5/direction/driving",
};

/**
 * 算两个坐标之间、按指定交通方式的一段路线（距离/时长/分步指令）。
 *
 * 与 transitMinutes 的分工：transitMinutes 只给一个分钟数（喂「绕路预警」
 * 和「节奏体检」）；本函数给完整路段，给「行中」渲染成可跟着走的路线链。
 * 两者都吃坐标，所以调用方应复用同一批 lookupPoi 结果，别重复解析。
 *
 * 三态：坐标缺失由调用方拦（本函数要求传入合法 "lng,lat"）；上游异常/
 * 无有效数据返回 unknown——拿空路段去渲染就是骗人，宁可不显示这段。
 */
/**
 * 两点直线距离（米）。haversine，够用于「选哪种交通方式」这种粗决策。
 */
export function haversineMeters(a: string, b: string): number {
  const [lng1, lat1] = a.split(",").map(Number);
  const [lng2, lat2] = b.split(",").map(Number);
  if (![lng1, lat1, lng2, lat2].every((n) => Number.isFinite(n))) return Number.NaN;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 「智能组合」模式：按**直线距离**选这一段用哪种交通方式。
 *
 * 为什么按直线距离而不是路线距离：选模式发生在算路线之前，我们没有路线距离；
 * 而直线距离 ×1.3 的绕路系数已足够区分「步行可达」和「必须坐车」。
 * 阈值口径（与 UI 文案一致，改动要同步）：
 *   ≤1.2km 步行（相邻景点/逛街，开车反而难找车位）
 *   ≤5km  骑行（城市中距离最舒服的方式）
 *   >5km  驾车（跨区/郊县）
 *
 * 诚实边界：高德公交/地铁 integrated 接口在多数个人 key 上不可用（实测
 * errcode 10002 SERVICE_NOT_AVAILABLE），所以「组合」目前是步行/骑行/驾车
 * 三者的**按段混选**，每一段都是对应方式的真实路线——不是把一段驾车路线
 * 拆成「地铁+步行」的表演。等 key 有公交权限后再加 transit。
 */
export function pickModeByDistance(meters: number): "walking" | "bicycling" | "driving" {
  if (!Number.isFinite(meters)) return "driving";
  if (meters <= 1200) return "walking";
  if (meters <= 5000) return "bicycling";
  return "driving";
}

export async function routeSegment(
  origin: string,
  destination: string,
  mode: TransportMode,
): Promise<RouteSegmentResult> {
  // auto：先按两点直线距离定这一段的方式，再用该方式的真实路线接口。
  // 坐标缺失（未验真/MOCK）时 haversine 返回 NaN → 退回驾车（不猜）。
  const effective =
    mode === "auto" ? pickModeByDistance(haversineMeters(origin, destination)) : mode;
  const r = await amapGetRetry(DIRECTION_PATH[effective], { origin, destination });
  if (!r.ok) return { state: "unknown", reason: r.detail };

  const path = (r.data as { route?: { paths?: Array<Record<string, unknown>> } })?.route
    ?.paths?.[0];
  const distanceM = Number(path?.distance);
  if (!Number.isFinite(distanceM) || distanceM <= 0) {
    return { state: "unknown", reason: "路线接口未返回有效距离" };
  }

  // 时长：walking/bicycling 在 path.cost.duration（实测 walking 就是这样，
  // 顶层没有 duration）；**driving 全链路都不返回时长**——paths[0] 只有
  // distance/restriction/steps，route 层只有 origin/destination/taxi_cost/
  // paths，steps 里也只有 instruction/orientation/road_name/step_distance。
  // 这是真机直连实测的结论；此前按「driving 在 cost.duration」写，配一个造了
  // 假 duration 的桩，测试全绿却真机 legs 全空——桩盖住了真实数据形状。
  //
  // driving 拿不到时长，就按 transitMinutes 同款口径从距离折算（市内综合
  // 均速 22km/h + 8 分钟寻路缓冲）：与「通勤总分钟数」同一模型，UI 上不引入
  // 第二套精度口径，也不冒充高德给了真值。
  //
  // **单位**：折算公式算出的是「分钟」（5000m → 约 22 分钟），而 PlanLeg.durationSec
  // 的契约是「秒」，必须 ×60。且口径要与 transitMinutes 严格一致：**先按分钟取整、
  // 再 ×60**（Math.round(...) * 60 = 22*60 = 1320），而不是先乘 60 再取整
  // （那样 21.636 分钟 → 1298 秒，与「通勤 22 分钟」对不上）。
  // 2026-10 联调踩过的坑：漏乘 60 时 5km 路段记成 22 秒，「时间轴接不上」体检拿
  // ceil(22/60)=1 分钟去比，真实模式永远判接得上（本轮核心预警失效），
  // UI 也把每段显示成「约1分钟」。
  // walking/bicycling 走 path.cost.duration，那是高德给的真实秒值（600 = 10 分钟），
  // 三种方式现在单位一致。
  let durationSec = Number((path?.cost as { duration?: string } | undefined)?.duration);
  if (!Number.isFinite(durationSec) || durationSec < 0) {
    durationSec = Math.round((distanceM / 1000 / 22) * 60 + 8) * 60;
  }

  const rawSteps = (path?.steps as Array<{ instruction?: string }> | undefined) ?? [];
  // 只取前 3 条非空指令：够人跟着走，又不把卡片撑爆。strip 掉高德指令里的
  // HTML 标签残留（实测偶有 <b> 之类）。
  const steps = rawSteps
    .map((s) =>
      String(s.instruction ?? "")
        .replace(/<[^>]*>/g, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 3);

  return { state: "ok", leg: { distanceM, durationSec, steps } };
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
  city: string; // 城市裸名（已归一化，如「北京」「成都」）
  district: string; // 区县（如「朝阳区」），仅用于展示
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

  const regeo = (
    r.data as {
      regeocode?: {
        addressComponent?: { city?: unknown; province?: unknown; district?: unknown };
        formatted_address?: unknown;
      };
    }
  )?.regeocode;
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
  name: string; // 地点名（填入输入框的值）
  detail: string; // 附属说明（区县/地址），展示用
  city: string; // 所属城市（裸名，如「成都」）——城市字段据此判断是否城市级
  isCity: boolean; // 是否为城市级结果（决定建议归属「城市」还是「具体地点」）
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
