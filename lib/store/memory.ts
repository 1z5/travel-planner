import "server-only";
import type { CodeRecord, JobRecord, QuotaRecord, Store } from "./types";

// ============================================================
// 内存实现：行为与原版（globalThis Map）完全一致，作为默认实现。
// 原版踩过的坑在此保留解法：Map 挂 globalThis，避免 dev 下各路由
// 模块实例化出多份状态（曾导致任务 404 / 配额不计）。
// ============================================================

const g = globalThis as typeof globalThis & {
  __tpJobs?: Map<string, JobRecord>;
  __tpQuota?: Map<string, QuotaRecord>;
  __tpCodes?: Map<string, CodeRecord>;
};

const jobs = (g.__tpJobs ??= new Map<string, JobRecord>());
const quota = (g.__tpQuota ??= new Map<string, QuotaRecord>());
const codes = (g.__tpCodes ??= new Map<string, CodeRecord>());

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const jobStore = {
  async create(record: JobRecord) {
    jobs.set(record.id, record);
  },
  async get(id: string) {
    return jobs.get(id) ?? null;
  },
  async update(id: string, patch: Partial<JobRecord>) {
    const cur = jobs.get(id);
    if (cur) jobs.set(id, { ...cur, ...patch });
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
  }, 600_000).unref?.();
}

export const memoryStore: Store = { jobs: jobStore, quota: quotaStore, codes: codeStore };
