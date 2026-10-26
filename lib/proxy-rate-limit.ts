import "server-only";
import { consume, hourKey } from "./ratelimit";
import { clientIpFromHeaders } from "./client-ip";

// ============================================================
// 只读高德代理端点的按 IP 小时限流（审计 P1-4）
//
// 为什么需要：/api/map、/api/places/*、/api/geocode、/api/weather 都直接消耗
// 高德 key 配额，此前完全没限流。公开演示站（简历链接）被转发后，一个脚本就能
// 把个人 key 的静态图日配额烧穿（当天真实用户全部降级成示意图），或者把地图的
// 全进程串行队列堵死（队头阻塞：真实用户排在攻击者后面）。
//
// 口径：按 IP 小时桶 + **宽容上限**（正常浏览远到不了）。这些端点便宜但量大，
// 目的是防刷量而不是按成功收费，所以不做失败退还——否则刷子用失败请求就能
// 绕过计数。需要更严格时调环境变量即可，无需改代码。
// ============================================================

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface ProxyRateLimitResult {
  allowed: boolean;
  limit: number;
}

/**
 * 检查某个只读代理端点的按 IP 小时额度。
 *
 * @param headers 请求头（用于取受信代理后的客户端 IP，见 lib/client-ip.ts）
 * @param scope 桶作用域（不同端点分开计数）
 * @param envName 限流环境变量名（如 MAP_HOURLY_LIMIT）
 * @param fallback 环境变量缺省/非法时的默认上限
 */
export async function checkProxyRateLimit(
  headers: Headers,
  scope: string,
  envName: string,
  fallback: number,
): Promise<ProxyRateLimitResult> {
  const limit = intEnv(envName, fallback);
  const ip = clientIpFromHeaders(headers);
  const result = await consume(hourKey(scope, ip), limit);
  return { allowed: result.allowed, limit };
}
