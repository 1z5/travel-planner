import "server-only";

// v0 防薅：按 IP 维度每日计数（内存实现）。
// 注意：serverless 部署后每个实例内存独立，仅作开发/单机演示；
// 上线前换成 Redis / 数据库计数（TODO: 登录体系落地时替换）。
//
// 状态同样挂 globalThis：与 jobs.ts 同理，避免 dev 下多模块实例
// 导致「路由扣了次数、任务失败却还不回」的串号问题。

interface Bucket { date: string; count: number }
const g = globalThis as typeof globalThis & { __travelQuota?: Map<string, Bucket> };
const buckets: Map<string, Bucket> = (g.__travelQuota ??= new Map());

// 配额上限：登录用户 10 次/天，未登录 3 次/天 / IP（见 /api/plan 的双轨逻辑）
export function userLimit(): number {
  return Number(process.env.AUTH_USER_LIMIT || 10);
}

// ---- 滑动窗口限流（发验证码防轰炸）----
// 固定窗口实现：每 windowMs 一个窗口，超限拒绝。v0 够用；
// 多实例部署前换 Redis（同 DAILY 配额）。
// 状态同样挂 globalThis：dev 下各路由会编译出独立的模块实例，
// 模块级 Map 会在请求间丢失（与 buckets 同理）
const g2 = globalThis as typeof globalThis & {
  __travelQuotaWindows?: Map<string, { w: number; c: number }>;
};
const windowBuckets: Map<string, { w: number; c: number }> =
  (g2.__travelQuotaWindows ??= new Map());

export function consumeWindow(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; remaining: number } {
  const w = Math.floor(Date.now() / windowMs);
  const b = windowBuckets.get(key);
  if (!b || b.w !== w) {
    windowBuckets.set(key, { w, c: 1 });
    return { allowed: true, remaining: limit - 1 };
  }
  if (b.c >= limit) return { allowed: false, remaining: 0 };
  b.c += 1;
  return { allowed: true, remaining: limit - b.c };
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function checkQuota(ip: string, limit: number): { allowed: boolean; remaining: number } {
  const b = buckets.get(ip);
  if (!b || b.date !== today()) return { allowed: true, remaining: limit - 1 };
  return { allowed: b.count < limit, remaining: Math.max(0, limit - b.count - 1) };
}

export function consume(ip: string, limit: number): { allowed: boolean; remaining: number } {
  const t = today();
  const b = buckets.get(ip);
  if (!b || b.date !== t) {
    buckets.set(ip, { date: t, count: 1 });
    return { allowed: true, remaining: limit - 1 };
  }
  b.count += 1;
  return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count) };
}

// 查看当前剩余次数（不扣减）——任务失败后退还后要用它刷新上报值
export function peek(ip: string, limit: number): number {
  const b = buckets.get(ip);
  if (!b || b.date !== today()) return limit;
  return Math.max(0, limit - b.count);
}

// 生成失败时归还次数（防薅不等于惩罚失败）
export function refund(ip: string, limit: number): void {
  const b = buckets.get(ip);
  if (b && b.date === today() && b.count > 0) b.count -= 1;
  void limit;
}

// 防内存无限增长：定期清理非今天的记录
if (typeof setInterval === "function") {
  setInterval(() => {
    const t = today();
    for (const [k, v] of buckets) if (v.date !== t) buckets.delete(k);
  }, 3600_000).unref?.();
}
