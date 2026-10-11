import "server-only";
import { getStore } from "./store";

// ============================================================
// 配额与限流：全部经 Store 门面（memory / postgres 可切换）。
// ============================================================

// 配额上限：登录用户 10 次/天，未登录 3 次/天 / IP（见 /api/plan 的双轨逻辑）
export function userLimit(): number {
  return Number(process.env.AUTH_USER_LIMIT || 10);
}

/** 每日配额：提交即扣，失败退还 */
export async function consume(key: string, limit: number) {
  return getStore().quota.consume(key, limit);
}

export async function refund(key: string) {
  return getStore().quota.refund(key);
}

/** 查看剩余（不扣减） */
export async function peek(key: string, limit: number) {
  return getStore().quota.peek(key, limit);
}

/**
 * 固定窗口限流（发验证码防轰炸）：单手机号 5 条/小时、单 IP 20 条/小时。
 * 实现技巧：把「小时序号」编进 key 复用每日配额机制——每个自然小时
 * 就是一个新桶，语义即固定窗口，memory/postgres 行为一致。
 */
export function hourKey(scope: string, id: string): string {
  const hour = Math.floor(Date.now() / 3600_000);
  return `win:${scope}:${id}:${hour}`;
}
