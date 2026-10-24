import "server-only";
import type { Plan, PlanInput } from "../types";

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
  key: string; // 配额键（u:<phone> 或 ip:<addr>）
  limit: number;
  createdAt: number;
  /**
   * 生成完成后指向持久化行程的分享 token（见 lib/plan-repo.ts）。
   * 缺省有两种含义：还没生成完（running）或持久化失败（done 但没有可分享链接）。
   * 前端据此决定是否显示分享/日历按钮——宁可隐藏，也不给一个打不开的链接。
   */
  shareId?: string;
  /**
   * 心跳：最后一次写入任务状态的时间（ms）。
   * 为什么单独存：createdAt 是任务提交时间，不能反映「进程还活着」。
   * status 路由用 now - updatedAt 识别服务重启/进程冻结留下的僵尸 running 任务，
   * 否则前端会对着一个永远不动的任务白轮询十几分钟。
   */
  updatedAt?: number;
}

export interface JobStore {
  create(record: JobRecord): Promise<void>;
  get(id: string): Promise<JobRecord | null>;
  /**
   * 局部更新。实现必须把这次写入当作一次心跳：即使 patch 为空也要刷新
   * updatedAt（jobs.ts 的轻量心跳就是空 patch 打一次，见 jobs.ts startHeartbeat）。
   */
  update(id: string, patch: Partial<JobRecord>): Promise<void>;
}

// ---------- 行程（一等聚合） ----------

/**
 * 持久化的行程记录：id 即分享 token（不可猜测，见 lib/plan-repo.ts newShareId）。
 *
 * 为什么把行程从 Job 里拆出来：Job 是一次性执行记录，TTL 只有 2 小时，而
 * 「分享链接 / 改行程 / 最近行程」都要求行程比生成过程活得久。拆出来后：
 *   - 分享链接指向 Plan，不随任务清理而失效
 *   - revision 让「改行程」有并发/审计语义（每次替换 +1）
 *   - input 保留用户原始需求，改行程时可以据此重跑体检/提示
 */
export interface PlanRecord {
  /** 分享 token（URL-safe，不可猜测；不要用 job id） */
  id: string;
  /** 生成它的任务 id（追溯用；同一 job 只应有一份 Plan，见 commitPlan 幂等） */
  jobId?: string;
  /** 归属键（当前复用配额 key：u:<phone> / ip:<addr>），为后续「最近行程」预留 */
  ownerKey?: string;
  plan: Plan;
  input: PlanInput;
  /** 修改版本号：创建为 1，每次 replace +1 */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanStore {
  /** 保存新行程。id 已存在时覆盖（upsert）——去重由 commitPlan 靠 job.shareId 保证 */
  save(record: PlanRecord): Promise<void>;
  get(id: string): Promise<PlanRecord | null>;
  /**
   * 改行程：revision+1、刷新 updatedAt，返回更新后的完整记录。
   *
   * 不存在时返回 null 而不是抛错：这是路由层要映射成 404 的正常业务分支，
   * 不是异常路径。抛错会让调用方用 try/catch 处理一个可预期的结果，还容易
   * 把「链接不存在」误报成 500（对比 validate 的三态原则：区分业务结果与故障）。
   */
  replace(id: string, plan: Plan): Promise<PlanRecord | null>;
}

// ---------- 配额（每日次数） ----------

export interface QuotaRecord {
  key: string;
  date: string; // YYYY-MM-DD
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
  expiresAt: number; // ms 时间戳
}

export interface CodeStore {
  put(record: CodeRecord): Promise<void>;
  /** 取码并校验；正确则一次性消费，失败保留（防爆破） */
  verify(phone: string, code: string): Promise<boolean>;
}

// ---------- 统一门面 ----------

export interface Store {
  jobs: JobStore;
  plans: PlanStore;
  quota: QuotaStore;
  codes: CodeStore;
  events: EventStore;
}

// ---------- 产品事件（度量闭环） ----------

/** 一条产品事件（只记行为，不记内容；字段含义见 lib/metrics.ts） */
export interface TripEventRecord {
  id: string;
  name: string;
  shareId?: string;
  city?: string;
  day?: number;
  meta?: Record<string, unknown>;
  createdAt: number;
}

export interface EventStore {
  /** 写入一条事件。存储失败**不抛错**——埋点不能拖垮主流程（与 grounding 同口径） */
  record(event: TripEventRecord): Promise<void>;
  /** 按条件拉取（看板聚合用；内存实现有上限，postgres 走索引） */
  list(filter: {
    since?: number;
    name?: string;
    shareId?: string;
    limit?: number;
  }): Promise<TripEventRecord[]>;
}
