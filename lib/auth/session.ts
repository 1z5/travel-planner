import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionPayload } from "./types";
import { DEV_SESSION_SECRET, isProductionSessionMisconfigured, type GuardEnv } from "./guards";

// ============================================================
// 自签 Session Cookie：payload.base64url + HMAC-SHA256(payload, secret)
// 无状态、无依赖。生产注明：多实例部署时撤销（登出）只能等自然过期，
// 或换 Redis/DB 会话（TODO M4+）。
//
// 生产 fail-closed：SESSION_SECRET 缺失或仍是公开的开发默认值时，
// 不签发也不接受任何 session——默认密钥写在源码里，任何人都能签出
// 任意手机号的 cookie，等于身份冒充。开发/测试（e2e 用 next dev）行为不变。
// ============================================================

export const SESSION_COOKIE = "tp_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

// 弱密钥只在首次真正用到 session 时记一条 error：每个请求都打会把日志刷爆，
// 反而掩盖真正的故障；一条就够运维定位「生产用了默认 secret」。
let productionSecretErrorLogged = false;

function secretOf(env: GuardEnv): string {
  return env.SESSION_SECRET || DEV_SESSION_SECRET;
}

/**
 * session 是否允许使用。仅生产环境检查 secret：e2e phase C/D/E 用 next dev
 * 且不设 SESSION_SECRET，依赖「开发默认密钥也能正常登录」的原行为。
 */
function sessionAllowed(env: GuardEnv): boolean {
  if (!isProductionSessionMisconfigured(env)) return true;
  if (!productionSecretErrorLogged) {
    productionSecretErrorLogged = true;
    console.error(
      "[auth/session] 生产环境 SESSION_SECRET 缺失或仍是开发默认值：已拒绝签发/校验 session，" +
        "请设置 SESSION_SECRET=openssl rand -hex 32",
    );
  }
  return false;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string, env: GuardEnv): string {
  return createHmac("sha256", secretOf(env)).update(payloadB64).digest("base64url");
}

/** @param env 默认 process.env；单测注入对象即可，无需改全局 env */
export function createSession(
  phone: string,
  env: GuardEnv = process.env,
): { token: string; maxAgeSec: number } {
  if (!sessionAllowed(env)) {
    throw new Error(
      "生产环境 SESSION_SECRET 缺失或仍是开发默认值，拒绝签发 session" +
        "（设置 SESSION_SECRET=openssl rand -hex 32）",
    );
  }
  const now = Date.now();
  const payload: SessionPayload = { p: phone, i: now, e: now + SESSION_TTL_MS };
  const payloadB64 = b64url(JSON.stringify(payload));
  return {
    token: `${payloadB64}.${sign(payloadB64, env)}`,
    maxAgeSec: Math.floor(SESSION_TTL_MS / 1000),
  };
}

/** @param env 默认 process.env；单测注入对象即可，无需改全局 env */
export function readSession(
  cookieHeader: string | null | undefined,
  env: GuardEnv = process.env,
): SessionPayload | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;

  // 弱密钥时不校验签名（验签用同一个公开默认值也没有意义）：一律当作未登录
  if (!sessionAllowed(env)) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const [payloadB64, sig] = [raw.slice(0, dot), raw.slice(dot + 1)];

  // 常量时间比较防时序攻击
  const expected = sign(payloadB64, env);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString()) as SessionPayload;
    if (payload.e < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// 是否给 cookie 打 Secure 标志：生产（NODE_ENV=production）默认打上；
// 本地 http 开发用 COOKIE_SECURE=0 关掉
export function cookieSecure(): boolean {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0") return false;
  return process.env.NODE_ENV === "production";
}

export function cookieHeader(token: string, maxAgeSec: number, secure = cookieSecure()): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
