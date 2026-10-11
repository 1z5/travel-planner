import "server-only";
import type { Plan } from "../types";

// ============================================================
// 存储抽象层：三块状态的统一接口。
//
// 为什么需要：项目原本三块状态全在 globalThis Map 里（jobs/quota/
// sms codes）——单机可用，但重启即丢、多实例全废。抽象出接口后：
//   memory   默认实现，行为与原版一致（dev/测试/单机）
//   postgres 持久化实现（Prisma），生产多实例部署用
// 由 DATA_STORE=memory|postgres 选择，路由层不感知差异。
// ============================================================

// ---------- 任务（行程生成） ----------

export interface JobRecord {
  id: string;
  status: "running" | "done" | "error";
  plan?: Plan;
  error?: string;
  key: string;        // 配额键（u:<phone> 或 ip:<addr>）
  limit: number;
  createdAt: number;
}

export interface JobStore {
  create(record: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  update(id: string, patch: Partial<JobRecord>): Promise<void>;
}

// ---------- 配额（每日次数） ----------

export interface QuotaRecord {
  key: string;
  date: string;       // YYYY-MM-DD
  count: number;
}

export interface QuotaStore {
  /** 扣减一次；返回是否允许与剩余次数 */
  consume(key: string, limit: number): Promise<{ allowed: boolean; remaining: number }>;
  /** 退还一次（生成失败时） */
  refund(key: string): Promise<void>;
  /** 查看剩余（不扣减） */
  peek(key: string, limit: number): Promise<number>;
}

// ---------- 短信验证码 ----------

export interface CodeRecord {
  phone: string;
  code: string;
  expiresAt: number;  // ms 时间戳
}

export interface CodeStore {
  put(record: CodeRecord): Promise<void>;
  /** 取码并校验；正确则一次性消费，失败保留（防爆破） */
  verify(phone: string, code: string): Promise<boolean>;
}

// ---------- 统一门面 ----------

export interface Store {
  jobs: JobStore;
  quota: QuotaStore;
  codes: CodeStore;
}
