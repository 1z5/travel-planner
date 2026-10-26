import "server-only";
import { isIP } from "node:net";

// ============================================================
// 客户端 IP 提取的唯一实现（配额 / 限流 / 防轰炸共用）
//
// 背景（2026-10 审计 P0-3）：8 处按 IP 限流各自取 `x-forwarded-for` 的
// **第一个值**。这个值完全由客户端控制：直连公网时可以直接伪造；即使前面
// 挂了 nginx，用常见的 `$proxy_add_x_forwarded_for` 也会把客户端伪造值
// 保留在首位。于是「每天 3 次免费」只要换一个头就是新用户，LLM 账单无上限。
//
// 取信规则（TRUSTED_PROXY_HOPS，默认 1）：
// - N >= 1：前面有 N 层受信反代。XFF 链**从右往左**数第 N 个才是真实客户端，
//   左侧全部是客户端可以伪造的。反代只要「追加」真实 IP（nginx 默认行为），
//   右侧就不可伪造；直接覆盖 XFF 的部署同样安全（链长 1）。
// - 0：不信任何转发头（直连公网）。Next Route Handler 不暴露 peer address，
//   此时只能退化为单桶 "direct"——配额不再是按 IP，而是全局限额。部署文档
//   必须要求接一层反代（见 DEPLOY.md 的 Runbook）。
//
// 只接受合法 IP 字面量：格式非法/超长值一律忽略。否则它会变成 memory 的
// Map key 或 PG 的 QuotaBucket.key，超长值能撑爆 btree（审计 P2-7）。
// ============================================================

/** 拿不到可信 IP 时的桶名：所有请求共享，等价于全局限额 */
export const DIRECT_IP = "direct";

/** 前面有几层受信反代（默认 1；非法/负数回落到默认值） */
export function trustedProxyHops(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.TRUSTED_PROXY_HOPS ?? "").trim();
  if (raw === "") return 1;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/**
 * 归一化一个 IP 字面量：容忍 "1.2.3.4:5678" 与 "[2001:db8::1]:443" 的端口写法，
 * 返回合法 IP（小写）或 null。IPv6 无方括号时含多个冒号，不能按端口切。
 */
function normalizeIp(raw: string): string | null {
  let v = raw.trim();
  if (!v) return null;
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end <= 0) return null;
    v = v.slice(1, end);
  } else {
    const firstColon = v.indexOf(":");
    const lastColon = v.lastIndexOf(":");
    // 只有一个冒号 = IPv4:port；多个冒号是裸 IPv6，保持原样
    if (firstColon > 0 && firstColon === lastColon) {
      const maybePort = v.slice(lastColon + 1);
      if (/^\d{1,5}$/.test(maybePort)) v = v.slice(0, lastColon);
    }
  }
  return isIP(v) ? v.toLowerCase() : null;
}

/** 解析 XFF 链，只保留合法 IP（客户端可以塞垃圾/超长串，全部丢掉） */
function parseForwardedChain(headers: Headers): string[] {
  const raw = headers.get("x-forwarded-for") ?? "";
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const ip = normalizeIp(part);
    if (ip) out.push(ip);
  }
  return out;
}

/**
 * 取「用于限流的客户端标识」。永远返回非空字符串（最差 "direct"），
 * 调用方可以直接拼进 quota key。
 */
export function clientIpFromHeaders(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  const hops = trustedProxyHops(env);
  if (hops === 0) return DIRECT_IP;

  const chain = parseForwardedChain(headers);
  if (chain.length >= hops) {
    // 从右往左数：右侧是受信反代追加的真实 IP
    return chain[chain.length - hops]!;
  }
  // 链不够长（请求没经过预期的反代）：退回单层头；仍不合法就共享 direct 桶
  const realIp = normalizeIp(headers.get("x-real-ip") ?? "");
  return realIp ?? DIRECT_IP;
}
