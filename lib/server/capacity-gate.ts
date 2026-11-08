import "server-only";

// ============================================================
// 服务端容量闸门：全局限并发 + 每日全站生成/LLM 预算
//
// 为什么需要（2026-10 审计 P0-3）：按 IP 的配额是「体验层」，它建立在
// 客户端标识可信的前提上；即使 IP 可信，也挡不住「一万个真实用户同时来」。
// 个人高德 key 3 并发就 10021、LLM 网关有速率限制，没有全局闸门时：
// 1) 上游限流 → 验真大片退化为 error → 用户看到「POI 未能验真」；
// 2) 谁在刷（或只是爆量）都能把模型账单拉满。
//
// 设计取舍：
// - **进程内状态**（挂 globalThis，跨 dev 模块实例共享）。多实例部署时每个
//   实例各有一份上限，等于「每实例上限」——仍然是有效护栏（单实例不会被打爆），
//   但不是集群级。诚实记录在 DEPLOY.md；要做集群级需 Redis/PG（后续）。
// - 日预算按 UTC 日（与现有配额日界同口径，见 lib/store/*.ts；一次部署
//   切换日界=所有配额历史重置，先不动，记在技术债里）。
// - 生成任务在终态释放并发槽；日预算**不退还**（失败的生成同样烧了 token，
//   退还反而让「失败重试」变成绕过预算的路径）。
// - 除「生成次数」外还有「LLM 调用次数」日预算：改行程/行程管家不占生成配额，
//   公开演示站在「链接被人转发/被爬」时，只有按 IP 小时桶挡不住换 IP 的刷子。
// ============================================================

export type GateKind = "generate" | "llm";

interface CapacityState {
  day: string;
  generationsToday: number;
  /** 今日全站 LLM 调用次数（生成 + refine + chat；生成内部的重试不单独计） */
  llmCallsToday: number;
  active: Record<GateKind, number>;
}

const g = globalThis as typeof globalThis & { __tpCapacity?: CapacityState };

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

const state: CapacityState = (g.__tpCapacity ??= {
  day: utcDay(),
  generationsToday: 0,
  llmCallsToday: 0,
  active: { generate: 0, llm: 0 },
});

function intEnv(name: string, fallback: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface CapacityLimits {
  /** 同时在跑的生成任务上限（每实例） */
  maxGenerations: number;
  /** 同时在跑的 LLM 调用上限（生成 + refine + chat，每实例） */
  maxLlmCalls: number;
  /** 每日全站生成次数上限（每实例，UTC 日） */
  dailyGenerations: number;
  /** 每日全站 LLM 调用次数上限（生成 + refine + chat，每实例，UTC 日） */
  dailyLlmCalls: number;
}

export function capacityLimits(): CapacityLimits {
  return {
    maxGenerations: intEnv("MAX_CONCURRENT_GENERATIONS", 6),
    maxLlmCalls: intEnv("MAX_CONCURRENT_LLM", 12),
    dailyGenerations: intEnv("DAILY_GLOBAL_LIMIT", 500),
    dailyLlmCalls: intEnv("DAILY_GLOBAL_LLM_LIMIT", 300),
  };
}

/** 跨 UTC 日把日计数归零（惰性：每次读写前检查，不靠定时器） */
function rollover(): void {
  const today = utcDay();
  if (state.day !== today) {
    state.day = today;
    state.generationsToday = 0;
    state.llmCallsToday = 0;
  }
}

/**
 * 抢一个并发槽。返回释放函数；当前已满时返回 null。
 * 释放函数幂等（重复调用只减一次），调用方在 finally 里调用即可。
 */
export function tryAcquireSlot(kind: GateKind): (() => void) | null {
  rollover();
  const limits = capacityLimits();
  const cap = kind === "generate" ? limits.maxGenerations : limits.maxLlmCalls;
  if (state.active[kind] >= cap) return null;
  state.active[kind] += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active[kind] = Math.max(0, state.active[kind] - 1);
  };
}

/** 预扣一次「今日全站生成」预算；超限返回 false（调用方应 429） */
export function tryReserveGenerationBudget(): boolean {
  rollover();
  if (state.generationsToday >= capacityLimits().dailyGenerations) return false;
  state.generationsToday += 1;
  return true;
}

/** 任务没建成（如落库失败）时退还预扣的日预算；不要用于「任务失败」 */
export function releaseGenerationBudget(): void {
  rollover();
  state.generationsToday = Math.max(0, state.generationsToday - 1);
}

/**
 * 预扣一次「今日全站 LLM 调用」预算；超限返回 false（调用方应 429/503）。
 * 在真正发起 LLM 调用之前扣：生成内部的重试不重复扣（一次生成算 1 次，
 * 因为生成次数本身另有预算），refine/chat 每次请求扣 1 次。
 */
export function tryReserveLlmBudget(): boolean {
  rollover();
  if (state.llmCallsToday >= capacityLimits().dailyLlmCalls) return false;
  state.llmCallsToday += 1;
  return true;
}

/** 预扣后才发现请求根本没走到 LLM（参数/行程不存在）时退还该次预算 */
export function releaseLlmBudget(): void {
  rollover();
  state.llmCallsToday = Math.max(0, state.llmCallsToday - 1);
}

/** 健康检查/诊断用快照（不含任何用户数据） */
export function capacitySnapshot(): CapacityState & { limits: CapacityLimits } {
  rollover();
  return {
    day: state.day,
    generationsToday: state.generationsToday,
    llmCallsToday: state.llmCallsToday,
    active: { ...state.active },
    limits: capacityLimits(),
  };
}

// ============================================================
// 测试专用：清空状态 / 伪造日界（业务代码不要调用）
// ============================================================
export function resetCapacityForTest(): void {
  state.day = utcDay();
  state.generationsToday = 0;
  state.llmCallsToday = 0;
  state.active.generate = 0;
  state.active.llm = 0;
}

export function setCapacityDayForTest(day: string): void {
  state.day = day;
}
