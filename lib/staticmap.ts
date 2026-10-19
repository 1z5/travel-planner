import "server-only";
import { createHash } from "node:crypto";
import { AMAP_BASE, AMAP_KEY, AMAP_MOCK, isTransientUpstream } from "./amap";
import { sleep } from "./concurrency";
import type { MapView } from "./map-view";

// ============================================================
// 高德静态地图代理（GET /v3/staticmap）——真实地图底图。
//
// 为什么需要服务端代理而不是前端直连：
// 1. key 是 Web 服务 key，直连会把 key 暴露给浏览器（可被刷额度）；
// 2. 个人 key 的 QPS 很低，实测连续快速请求会返回
//    10021 CUQPS_HAS_EXCEEDED_THE_LIMIT。必须服务端缓存 + 串行化上游请求；
// 3. 高德出错时返回的是 HTTP 200 + JSON body，前端 <img> 会拿到「数字图片」
//    或破图——服务端能把错误拦成 502，让前端明确降级。
//
// 已验证事实（真实 key，2026-10）：
// - `location=lng,lat&zoom=12&size=750*420&scale=2` 返回 1500×840 PNG；
// - `paths`（折线）参数在本项目 key 上恒返回 20003，路线连线由组件自绘，
//   所以这里**只取底图**，不传 markers/paths。
// ============================================================

/** 缓存上限：一次行程最多 10 天 × 每天一张，200 条足够覆盖多份行程 */
const CACHE_MAX = 200;
/** TTL 7 天：底图只随中心/zoom 变化，地理数据几乎不变；与 HTTP 缓存头对齐 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/** 只重试 1 次：限流是秒级窗口，退避跨过 1 秒后大多数情况已恢复 */
const MAX_ATTEMPTS = 2;
const RATE_LIMIT_BACKOFF_MS = 1_200;

interface CacheEntry {
  /** 写入时间（ms），用于 TTL 判定 */
  t: number;
  bytes: Buffer;
  contentType: string;
}

/** 内存 LRU：key = 完整请求 URL 的 sha1（含 key，避免不同配置互相污染） */
const cache = new Map<string, CacheEntry>();

/** 在飞去重：同一天的多张图不会重复请求（React 重渲染/多标签页可能同时要同一张） */
const inflight = new Map<string, Promise<StaticMapResult>>();

/**
 * 上游串行队列。
 *
 * 为什么必须串行：个人 key 的静态地图 QPS 很低，而行程页会**同时**渲染
 * 每天一张地图（5 天行程 = 5 个并发请求）。实测并发 3 个以上就开始出
 * 10021 限流，然后全部降级成 fallback——用户看到的是「地图服务不可用」，
 * 但根因是我们自己打了自己的 key。串行 + 缓存后，正常情况下每张图只请求
 * 一次（约 300ms），5 天行程的多等 1 秒换来全部成功，划算。
 */
let upstreamTail: Promise<unknown> = Promise.resolve();
function enqueueUpstream<T>(fn: () => Promise<T>): Promise<T> {
  const run = upstreamTail.then(fn, fn);
  // 队列尾部吞掉异常：否则一次失败会让后续排队的任务永远拒绝
  upstreamTail = run.catch(() => undefined);
  return run;
}

export type StaticMapResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; reason: string };

/**
 * 地图能力是否可用。
 * 无 key（MOCK 模式）或显式 AMAP_MAP_DISABLED=1（预发/离线环境，避免白打
 * 配额）都视为不可用——路由据此返回 503，前端降级回示意图，不假装有地图。
 */
export function staticMapEnabled(): boolean {
  return !AMAP_MOCK && process.env.AMAP_MAP_DISABLED !== "1";
}

/**
 * 高德静态地图的 zoom 编号比标准 Web Mercator（Google/OSM 口径）**大 1**。
 *
 * 这是本轮实测出来的关键坑（真 key + 图像配准验证，2026-10）：
 * 两个只差 0.01° 经度的同 zoom 地图做像素配准，实测：
 * - 请求 zoom=11、scale=2 → 图像 16.51 m/像素 = 标准 zoom 12 的 scale2 分辨率；
 * - 请求 zoom=14、scale=1 → 图像 4.13 m/像素 = 标准 zoom 15 的 scale1 分辨率；
 * - 请求 zoom=14、scale=2 → 图像 2.06 m/像素 = 标准 zoom 15 的 scale2 分辨率。
 * 即：**地图级别编号偏移恒为 +1，与 scale 无关**（高德 JS API 的 zoom 口径
 * 本来就与 Google 差一级）。
 *
 * 后果：如果直接透传我们的 zoom，底图覆盖的地理范围会只有预期的一半，
 * 自绘编号标记会全部漂到地图外。所以发送给高德时统一减 1，
 * 保证「请求 view.zoom = Z」时底图就是标准 Z 级，覆盖层按 256*2^Z 投影即可对齐。
 */
export const AMAP_ZOOM_OFFSET = 1;

/**
 * 构造静态地图查询参数（纯函数，不含 key，便于单测）。
 *
 * size 用高德规定的 `宽*高` 格式；scale 只接受 1/2（2 = 高清屏 2 倍图）。
 * 中心点保留 6 位小数（约 0.1m）：既避免浮点长尾让缓存 key 不稳定，
 * 又远小于一个像素对应的距离。
 */
export function buildStaticMapQuery(
  view: MapView,
  width: number,
  height: number,
  scale: 1 | 2,
): Record<string, string> {
  return {
    location: `${round6(view.center.lng)},${round6(view.center.lat)}`,
    // 减 1：高德 zoom 编号比标准 Web Mercator 大一级（见 AMAP_ZOOM_OFFSET）
    zoom: String(Math.round(view.zoom) - AMAP_ZOOM_OFFSET),
    size: `${Math.round(width)}*${Math.round(height)}`,
    scale: String(scale),
  };
}

function round6(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** 完整请求 URL（含 key）。只在服务端使用，绝不返回给浏览器 */
function staticMapUrl(view: MapView, width: number, height: number, scale: 1 | 2): URL {
  const url = new URL(`${AMAP_BASE}/v3/staticmap`);
  url.searchParams.set("key", AMAP_KEY!);
  for (const [k, v] of Object.entries(buildStaticMapQuery(view, width, height, scale))) {
    url.searchParams.set(k, v);
  }
  return url;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** PNG 魔数：高德理论上只返回 PNG，但上游抽风返回 HTML/空 body 时不能当图片 */
function isPng(bytes: Buffer): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

const lastLogged = new Map<string, number>();
/** 日志去重：限流时同一条错误会在多个请求里重复出现，60 秒窗口内只记一次 */
function logOnce(msg: string, windowMs = 60_000): void {
  const now = Date.now();
  const prev = lastLogged.get(msg);
  if (prev !== undefined && now - prev < windowMs) return;
  if (lastLogged.size > 100) lastLogged.clear();
  lastLogged.set(msg, now);
  console.warn(msg);
}

/** 写入缓存并做 LRU 淘汰（Map 迭代序 = 插入序，淘汰最旧） */
function cacheSet(key: string, bytes: Buffer, contentType: string): void {
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key); // 覆盖写入时先删后插，保持「最近使用」在队尾
  cache.set(key, { t: Date.now(), bytes, contentType });
}

/**
 * 请求上游并带一次限流退避重试。
 *
 * 错误语义很关键：任何失败都返回 ok:false，**绝不**把上游的 JSON 错误体
 * 当成图片返回（否则前端会渲染一张「数字图片」破图，用户不知道发生了什么）。
 */
async function requestUpstream(url: URL): Promise<StaticMapResult> {
  let lastReason = "未知错误";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(RATE_LIMIT_BACKOFF_MS);
    try {
      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const contentType = normalizeContentType(res.headers.get("content-type"));

      if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
        // 5xx/429 视为瞬时；其余（401/403 等）重试无意义，直接失败
        const transient = res.status === 429 || res.status >= 500;
        if (transient && attempt < MAX_ATTEMPTS) continue;
        return { ok: false, status: 502, reason: lastReason };
      }

      if (!contentType.startsWith("image/")) {
        // 高德参数/配额错误仍是 HTTP 200，body 是 {status:"0",info,infocode} JSON
        const data = (await res.json().catch(() => null)) as
          | { status?: unknown; info?: unknown; infocode?: unknown }
          | null;
        const info = String(data?.info ?? "");
        const infocode = String(data?.infocode ?? "");
        lastReason = data ? `${infocode} ${info || "未知错误"}`.trim() : "上游返回的内容不是图片";
        const transient = !!data && isTransientUpstream(info, infocode);
        if (transient && attempt < MAX_ATTEMPTS) continue;
        logOnce(`[staticmap] 高德拒绝请求 infocode=${infocode || "-"} info=${info || "-"}——地图将降级为示意图`);
        return { ok: false, status: 502, reason: lastReason };
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      if (!isPng(bytes)) {
        // 非瞬时异常：重试大概率还是同样结果，直接失败并留日志
        logOnce(`[staticmap] 上游返回了 image/* 但不是合法 PNG（${bytes.length} bytes）`);
        return { ok: false, status: 502, reason: "上游返回的不是合法 PNG" };
      }
      return { ok: true, bytes, contentType: "image/png" };
    } catch (e) {
      // 网络异常 / 超时：瞬时，重试一次
      lastReason = (e as Error)?.message || "网络异常";
      if (attempt < MAX_ATTEMPTS) continue;
      logOnce(`[staticmap] 请求失败：${lastReason}`);
      return { ok: false, status: 502, reason: lastReason };
    }
  }
  return { ok: false, status: 502, reason: lastReason };
}

/**
 * 取静态地图底图（带 LRU 缓存 + 在飞去重 + 上游串行）。
 *
 * @param scale 1 = 普通屏，2 = 高清屏（图片实际尺寸 ×2，但地理范围不变）
 * @returns ok:true 时 bytes 一定是合法 PNG；失败时 status 供路由映射成 HTTP 状态
 */
export async function fetchStaticMap(
  view: MapView,
  width: number,
  height: number,
  scale: 1 | 2,
): Promise<StaticMapResult> {
  if (!staticMapEnabled()) {
    return { ok: false, status: 503, reason: "地图未配置" };
  }

  const url = staticMapUrl(view, width, height, scale);
  const cacheKey = sha1(url.toString());
  const now = Date.now();
  const hit = cache.get(cacheKey);
  if (hit && now - hit.t < CACHE_TTL_MS) {
    // LRU touch：重新插入到队尾，避免热图被新图挤掉
    cache.delete(cacheKey);
    cache.set(cacheKey, hit);
    return { ok: true, bytes: hit.bytes, contentType: hit.contentType };
  }
  if (hit) cache.delete(cacheKey); // 过期条目清掉，避免后续误命中

  const running = inflight.get(cacheKey);
  if (running) return running;

  const task = enqueueUpstream(async () => {
    const result = await requestUpstream(url);
    if (result.ok) cacheSet(cacheKey, result.bytes, result.contentType);
    return result;
  });
  inflight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflight.delete(cacheKey);
  }
}

function normalizeContentType(raw: string | null): string {
  return (raw ?? "").split(";")[0]!.trim().toLowerCase();
}

/**
 * 仅测试/诊断用：读取缓存条目数。
 * 不暴露给业务代码——缓存是内部优化，调用方不应依赖。
 */
export function staticMapCacheSize(): number {
  return cache.size;
}
