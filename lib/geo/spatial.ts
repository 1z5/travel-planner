// ============================================================
// 空间算术的唯一实现（client-safe 纯函数）：坐标解析、haversine 公式、
// 「lng,lat」字符串距离、距离格式化。
//
// 【为什么有这一模块】（重构 ADR-020 · R5）
// 收敛前 haversine 公式有两份：lib/geo/amap.ts 的 haversineMeters
// （字符串入、坏输入出 NaN）与 lib/trip/trip-day.ts 的 distMeters
// （字符串入、坏输入出 null、结果取整）——后者内部又实现了一遍同公式。
// 高德 POI 坐标与「我离这站多远」必须给出同一个距离，否则同一对坐标
// 在两个界面显示不同米数。本文件是公式与解析的唯一来源：
//   - amap.ts 保留 haversineMeters 字符串包装（NaN 契约不动——
//     pickModeByDistance 依赖「非有限 → 驾车」的降级，见其注释）；
//   - trip-day.ts 的 distMeters / fmtDist 迁到本文件，消费方改从这里 import。
// ============================================================

/** 解析 "lng,lat" → [lng, lat]；空/格式错/非有限数返回 null（不猜坐标） */
export function parseLngLat(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/**
 * 两个 [lng, lat] 坐标间的地表距离（米，haversine 公式）。
 * 够用于「选哪种交通方式」「离这站多远」这类粗决策；精确路线距离
 * 走高德 routeSegment，不拿直线距离冒充。
 */
export function haversineMeters(
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const R = 6371000; // 地球半径（米）
  const toRad = (d: number) => (d * Math.PI) / 180;
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * 两个 "lng,lat" 坐标间的地表距离（米，取整）。解析失败返回 null——
 * 未验真的景点没有坐标，此时算不出距离，调用方据此降级而不是编一个数。
 */
export function distMeters(a: string | undefined, b: string | undefined): number | null {
  const pa = parseLngLat(a);
  const pb = parseLngLat(b);
  if (!pa || !pb) return null;
  return Math.round(haversineMeters(pa, pb));
}

/** 距离格式化：<1km 用米，否则用公里（一位小数） */
export function fmtDist(meters: number): string {
  return meters < 1000 ? `${meters} 米` : `${(meters / 1000).toFixed(1)} 公里`;
}
