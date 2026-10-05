import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionPayload } from "./types";

// ============================================================
// 自签 Session Cookie：payload.base64url + HMAC-SHA256(payload, secret)
// 无状态、无依赖。生产注明：多实例部署时撤销（登出）只能等自然过期，
// 或换 Redis/DB 会话（TODO M4+）。
// ============================================================

export const SESSION_COOKIE = "tp_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

function secret(): string {
  return process.env.SESSION_SECRET || "dev-only-insecure-secret";
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payloadB64: string): string {
  return createHmac("sha256", secret()).update(payloadB64).digest("base64url");
}

export function createSession(phone: string): { token: string; maxAgeSec: number } {
  const now = Date.now();
  const payload: SessionPayload = { p: phone, i: now, e: now + SESSION_TTL_MS };
  const payloadB64 = b64url(JSON.stringify(payload));
  return { token: `${payloadB64}.${sign(payloadB64)}`, maxAgeSec: Math.floor(SESSION_TTL_MS / 1000) };
}

export function readSession(cookieHeader: string | null | undefined): SessionPayload | null {
  if (!cookieHeader) return null;
  const raw = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;

  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const [payloadB64, sig] = [raw.slice(0, dot), raw.slice(dot + 1)];

  // 常量时间比较防时序攻击
  const expected = sign(payloadB64);
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
