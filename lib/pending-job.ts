// 「进行中的任务」本地句柄：把 jobId 留在浏览器里，用户离开/刷新/切后台回来
// 还能续上轮询。
//
// 为什么存在：生成一次要 2-7 分钟，页面文案明确承诺「期间可以离开页面，结果会
// 保留」（app/home-client.tsx 的 new-sub / form-actions-note）。但 jobId 原来只活
// 在组件 state 里：一次刷新（移动端切 App 被系统回收更常见）就连轮询一起丢，
// 服务端其实还在跑、额度也已经扣了，用户却永远拿不到结果。本模块把 jobId 变成
// 「这台设备上的一次未完成任务」，挂载时自动续上。
//
// 边界约定（照 lib/recent-trips.ts 的踩坑范式，逐条兜住）：
// 1. SSR 下没有 window：所有函数在服务端静默降级，调用方在 effect 里用
// 2. localStorage 可能被禁用/写满：读写全程 try-catch，失败即忘记恢复能力
// 3. 历史数据可能是旧结构/脏数据：逐字段校验，坏条目直接丢弃并清掉
// 4. TTL 与服务端 Job 记录同口径（2 小时）：过期任务在服务端也查不到了，
//    继续留着只会让下次打开多发一次必然 404 的请求（还会误报「任务已过期」）

const STORAGE_KEY = "tp.pending-job.v1";

/** 与服务端 Job 记录 TTL 同口径（2 小时，见 lib/store/memory.ts 的任务清理） */
export const PENDING_JOB_TTL_MS = 2 * 3600_000;

export interface PendingJob {
  jobId: string;
  /** 提交成功的时刻（ms）：恢复后秒表从真实起点算，不把已等待时间显示成 0 */
  createdAt: number;
  /** 本次提交的总天数：恢复后「已生成 N/M 天」要用；未知时不传 */
  days?: number;
}

function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isPendingJob(v: unknown): v is PendingJob {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  if (typeof r.jobId !== "string" || r.jobId.length < 1 || r.jobId.length > 128) return false;
  if (typeof r.createdAt !== "number" || !Number.isFinite(r.createdAt) || r.createdAt <= 0)
    return false;
  if (r.days !== undefined) {
    if (typeof r.days !== "number" || !Number.isInteger(r.days) || r.days < 1 || r.days > 30)
      return false;
  }
  return true;
}

/** 记下当前进行中的任务。写失败（隐私模式/配额满）静默降级：不影响本次生成 */
export function savePendingJob(job: PendingJob): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
  } catch {
    /* 隐私模式 / 写满：失去「离开后恢复」能力，但不影响当前页面 */
  }
}

/**
 * 读取未完成任务。返回 null 的三种情况：没存过、已过期、数据坏了。
 * 后两种会顺手清掉，避免坏数据一直挡着。
 */
export function loadPendingJob(now = Date.now()): PendingJob | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingJob(parsed) || now - parsed.createdAt > PENDING_JOB_TTL_MS) {
      clearPendingJob();
      return null;
    }
    return parsed;
  } catch {
    clearPendingJob();
    return null;
  }
}

/** 任务进入终态（done/error/404/超时）时清掉：不该在下次打开时再续一个已结束的任务 */
export function clearPendingJob(): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 清不掉不影响正确性：过期校验会兜底 */
  }
}

/** 测试/诊断用：暴露存储键名，业务代码不应依赖 */
export const PENDING_JOB_STORAGE_KEY = STORAGE_KEY;
