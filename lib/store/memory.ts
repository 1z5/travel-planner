import "server-only";
import type { CodeRecord, JobRecord, PlanRecord, QuotaRecord, Store } from "./types";

// ============================================================
// 内存实现：行为与原版（globalThis Map）完全一致，作为默认实现。
// 原版踩过的坑在此保留解法：Map 挂 globalThis，避免 dev 下各路由
// 模块实例化出多份状态（曾导致任务 404 / 配额不计）。
// ============================================================

const g = globalThis as typeof globalThis & {
  __tpJobs?: Map<string, JobRecord>;
  __tpPlans?: Map<string, PlanRecord>;
  __tpQuota?: Map<string, QuotaRecord>;
  __tpCodes?: Map<string, CodeRecord>;
};

const jobs = (g.__tpJobs ??= new Map<string, JobRecord>());
// 行程是持久聚合，和 2 小时的任务记录分开存：分享链接不能跟着任务一起过期
const plans = (g.__tpPlans ??= new Map<string, PlanRecord>());
const quota = (g.__tpQuota ??= new Map<string, QuotaRecord>());
const codes = (g.__tpCodes ??= new Map<string, CodeRecord>());

/** 行程保留 30 天：比 job 的 2 小时长得多，覆盖「发给朋友过几天再打开」 */
// 内存模式（dev/单机）保留 30 天：只是为了防长驻进程无限增长。
// 生产用 postgres 实现，行程不设 TTL（见 store/postgres.ts 注释）。
const PLAN_TTL_MS = 30 * 24 * 3600_000;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const jobStore = {
  async create(record: JobRecord) {
    jobs.set(record.id, { ...record, updatedAt: record.updatedAt ?? record.createdAt });
  },
  async get(id: string) {
    return jobs.get(id) ?? null;
  },
  async update(id: string, patch: Partial<JobRecord>) {
    const cur = jobs.get(id);
    // 任何一次 update 都算心跳：调用方可以不传 patch（空对象 = 纯保活），
    // 陈旧任务判定依赖这里持续刷新 updatedAt
    if (cur) jobs.set(id, { ...cur, ...patch, updatedAt: patch.updatedAt ?? Date.now() });
  },
};

const planStore = {
  async save(record: PlanRecord) {
    plans.set(record.id, record);
  },
  async get(id: string) {
    return plans.get(id) ?? null;
  },
  async replace(id: string, plan: PlanRecord["plan"]) {
    const cur = plans.get(id);
    // 不存在返回 null，不抛错：「链接不存在」是业务分支（404），不是故障
    if (!cur) return null;
    const next: PlanRecord = {
      ...cur,
      plan,
      revision: cur.revision + 1,
      updatedAt: Date.now(),
    };
    plans.set(id, next);
    return next;
  },
};

const quotaStore = {
  async consume(key: string, limit: number) {
    const t = today();
    const b = quota.get(key);
    if (!b || b.date !== t) {
      quota.set(key, { key, date: t, count: 1 });
      return { allowed: true, remaining: limit - 1 };
    }
    b.count += 1;
    return { allowed: b.count <= limit, remaining: Math.max(0, limit - b.count) };
  },
  async refund(key: string) {
    const b = quota.get(key);
    if (b && b.date === today() && b.count > 0) b.count -= 1;
  },
  async peek(key: string, limit: number) {
    const b = quota.get(key);
    if (!b || b.date !== today()) return limit;
    return Math.max(0, limit - b.count);
  },
};

const codeStore = {
  async put(record: CodeRecord) {
    codes.set(record.phone, record);
  },
  async verify(phone: string, code: string) {
    const entry = codes.get(phone);
    if (!entry) return false;
    if (entry.expiresAt < Date.now()) {
      codes.delete(phone);
      return false;
    }
    const ok = entry.code === code;
    if (ok) codes.delete(phone); // 一次性消费
    return ok;
  },
};

// 定期清理（同原版）
if (typeof setInterval === "function") {
  setInterval(() => {
    const t = today();
    const now = Date.now();
    for (const [k, v] of quota) if (v.date !== t) quota.delete(k);
    for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
    // 任务保留 2 小时（同原 TTL）
    for (const [k, v] of jobs) if (v.createdAt < now - 2 * 3600_000) jobs.delete(k);
    // 行程至少保留 30 天：分享链接的核心价值就是「过几天再打开」，
    // 不能像任务那样 2 小时就清掉（这正是本轮要修的产品谎言）。
    // 生产 Postgres 模式不清理，这里是内存模式的内存护栏。
    for (const [k, v] of plans) if (v.updatedAt < now - PLAN_TTL_MS) plans.delete(k);
  }, 600_000).unref?.();
}

export const memoryStore: Store = {
  jobs: jobStore,
  plans: planStore,
  quota: quotaStore,
  codes: codeStore,
};
