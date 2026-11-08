// 真实地图的「视野数学」：Web Mercator 投影 + 视野拟合 + 像素投影。
//
// 为什么必须自己算：
// 高德静态地图接口在本项目 key 上 `paths`（折线）参数恒返回 20003 UNKNOWN_ERROR
// （多种官方格式都试过），路线连线只能自绘。自绘要求覆盖层与底图**逐像素对齐**——
// 底图是 Web Mercator 瓦片、256px tile、zoom 为整数，所以这里严格按同一套
// 数学实现（世界坐标归一化到 [0,1]，再乘 256 * 2^zoom 得到像素）。
//
// 本文件是 **client-safe 纯函数**：不 import "server-only"、不碰 fs/env。
// 服务端路由用 fitView 决定静态图中心/zoom，客户端用同一函数算覆盖层坐标，
// 两端必须调用同一实现，否则编号标记会从底图上的真实位置漂走。

/** 一个经纬度点（GCJ-02 坐标，与高德底图同坐标系） */
export interface MapPoint {
  lng: number;
  lat: number;
}

/** 视野：底图中心 + 整数缩放级别（与高德静态地图 location/zoom 参数一一对应） */
export interface MapView {
  center: MapPoint;
  zoom: number;
}

/** 静态地图的 tile 尺寸（Web Mercator 标准，高德同样为 256） */
const TILE_SIZE = 256;
/** Web Mercator 的纬度上限（超出后 y 趋于无穷，必须夹取） */
export const MAX_MERCATOR_LAT = 85.0511287798066;
export const MIN_ZOOM = 10;
export const MAX_ZOOM = 16;
/** 默认视野：成都天府广场附近。无坐标时给一个「大概知道在哪」而不是空白 */
export const DEFAULT_CENTER: MapPoint = { lng: 104.0665, lat: 30.5728 };
export const DEFAULT_ZOOM = 12;
/** 单点/重合点用固定 zoom：没有 bbox 可供拟合，给一个「城市街区级」的观感 */
export const SINGLE_POINT_ZOOM = 14;
/** fitView 默认留白（像素）：给编号圆点（r≈11）与站名标签留出空间，避免贴边裁切 */
export const DEFAULT_PADDING = 36;

/**
 * 经纬度 → Web Mercator 归一化世界坐标 [0,1]×[0,1]。
 * y 轴向下（与屏幕坐标一致），因此北纬小、南纬大。
 */
export function mercator(lng: number, lat: number): { x: number; y: number } {
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat));
  const x = (lng + 180) / 360;
  const sin = Math.sin((clampedLat * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  return { x, y };
}

/** 归一化世界坐标 → 经纬度（fitView 求 bbox 中心后转回中心点用） */
function inverseMercator(x: number, y: number): MapPoint {
  const lng = x * 360 - 180;
  const n = Math.PI - 2 * Math.PI * y;
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lng, lat };
}

/** 坐标是否可用：有限数 + 在合法经纬度范围内（纬度按 Mercator 上限夹取） */
export function isValidPoint(p: MapPoint | null | undefined): p is MapPoint {
  if (!p) return false;
  if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) return false;
  return Math.abs(p.lng) <= 180 && Math.abs(p.lat) <= MAX_MERCATOR_LAT;
}

/**
 * 拟合视野：让所有点都落在 (width - 2*padding) × (height - 2*padding) 内。
 *
 * 取「能容纳 bbox 的最大整数 zoom」——高德静态地图只接受整数 zoom（传小数会
 * 被截断，中心和缩放就对不上了）。
 *
 * 容错契约（调用方在渲染路径上，不能抛错打断整页）：
 * - 没有合法点 → 成都默认中心 + DEFAULT_ZOOM
 * - 单点/所有点重合 → 用该点居中 + 固定 zoom 14（bbox 为 0，无法拟合）
 * - bbox 过大/过小 → zoom 夹取到 [MIN_ZOOM, MAX_ZOOM]（此时部分点可能出画，
 *   但底图仍能显示、标记不会被裁成 NaN）
 */
export function fitView(
  points: MapPoint[],
  width: number,
  height: number,
  padding: number = DEFAULT_PADDING,
): MapView {
  // 尺寸兜底：SSR / jsdom 下可能传入 0 或 NaN
  const w = Number.isFinite(width) && width > 0 ? width : 720;
  const h = Number.isFinite(height) && height > 0 ? height : 400;
  const minSide = Math.min(w, h);
  // padding 不能把可视区域吃成负数（极端小图）
  const pad = Number.isFinite(padding)
    ? Math.max(0, Math.min(padding, minSide / 2 - 4))
    : DEFAULT_PADDING;

  const valid = (points ?? []).filter(isValidPoint);
  if (valid.length === 0) return { center: { ...DEFAULT_CENTER }, zoom: DEFAULT_ZOOM };

  const projected = valid.map((p) => mercator(p.lng, p.lat));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const m of projected) {
    if (m.x < minX) minX = m.x;
    if (m.x > maxX) maxX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.y > maxY) maxY = m.y;
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // 重合点：世界坐标跨度在浮点精度内为 0（约 1e-12 世界单位 ≈ 4e-5 像素）
  if (spanX < 1e-12 && spanY < 1e-12) {
    return { center: { lng: valid[0].lng, lat: valid[0].lat }, zoom: SINGLE_POINT_ZOOM };
  }

  const availW = Math.max(1, w - 2 * pad);
  const availH = Math.max(1, h - 2 * pad);
  // 世界像素边长 = 256 * 2^zoom，于是 256 * 2^zoom * span <= avail
  const zoomX = spanX > 0 ? Math.log2(availW / (TILE_SIZE * spanX)) : Infinity;
  const zoomY = spanY > 0 ? Math.log2(availH / (TILE_SIZE * spanY)) : Infinity;
  const fit = Math.min(zoomX, zoomY);
  const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(fit)));

  return { center: inverseMercator((minX + maxX) / 2, (minY + maxY) / 2), zoom };
}

/**
 * 经纬度 → 覆盖层像素坐标（原点在静态图左上角，单位为逻辑像素）。
 *
 * 关键：静态地图 `size=w*h` 定义的是**逻辑像素**，`scale=2` 只是把实际图片
 * 放大成 2w×2h（高清屏），地理映射仍按逻辑尺寸 w×h。所以覆盖层 viewBox 用
 * w×h 就能和底图严格对齐，不需要乘 scale。
 */
export function projectPixels(
  points: MapPoint[],
  view: MapView,
  width: number,
  height: number,
): Array<{ x: number; y: number }> {
  const w = Number.isFinite(width) && width > 0 ? width : 720;
  const h = Number.isFinite(height) && height > 0 ? height : 400;
  const scale = TILE_SIZE * 2 ** view.zoom;
  const center = mercator(view.center.lng, view.center.lat);
  return (points ?? []).map((p) => {
    const m = mercator(p.lng, p.lat);
    return {
      x: (m.x - center.x) * scale + w / 2,
      y: (m.y - center.y) * scale + h / 2,
    };
  });
}

/** 严格解析 "lng,lat"（高德 location 字段格式）。任何不合法都返回 null，绝不猜 */
export function parseLocText(loc: string | undefined | null): MapPoint | null {
  if (typeof loc !== "string") return null;
  const parts = loc.split(",");
  if (parts.length !== 2) return null;
  const num = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
  const lngText = parts[0].trim();
  const latText = parts[1].trim();
  // 注意 "104.07," 这种尾巴为空的情况：Number("") === 0，会悄悄变成 (104.07, 0)，
  // 必须先用正则排除空串
  if (!num.test(lngText) || !num.test(latText)) return null;
  const lng = Number(lngText);
  const lat = Number(latText);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (Math.abs(lng) > 180 || Math.abs(lat) > MAX_MERCATOR_LAT) return null;
  return { lng, lat };
}
