import "server-only";
import { generatePlan } from "./planner";
import { validatePlan } from "./validate";
import type { Plan, PlanInput } from "./types";

// ============================================================
// 异步任务：POST 立即返回 jobId，生成在后台进行，前端轮询进度。
//
// 为什么不用「等生成完再响应」：生成要 3-4 分钟，同步请求在多数
// 部署环境（含浏览器耐心）里都撑不住；异步后无论多慢，前端都能
// 展示实时进度，刷新前任务不丢（内存态，重启丢失见 README）。
//
// 状态存 globalThis：dev 下各路由的模块实例可能被编译成多份
// （实测 POST 与 GET 读到不同 Map 导致任务 404），挂 globalThis
// 后同进程内共享，HMR 重编译也不丢。
// ============================================================

export interface Job {
  id: string;
  status: "running" | "done" | "error";
  plan?: Plan;
  error?: string;
  ip: string;
  limit: number;
  createdAt: number;
}

type JobStore = Map<string, Job>;
const g = globalThis as typeof globalThis & { __travelJobs?: JobStore };
const jobs: JobStore = (g.__travelJobs ??= new Map());

function newId(): string {
  return `job_${Date.now().toString(36)}${(jobs.size + 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createJob(
  input: PlanInput,
  ip: string,
  limit: number,
  onError?: () => void,
): Job {
  const job: Job = {
    id: newId(),
    status: "running",
    ip,
    limit,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  console.log(
    `[job] ${job.id} 开始 城市=${input.city} 天数=${input.days} 预算=${input.budget}`,
  );
  void (async () => {
    const t0 = Date.now();
    try {
      job.plan = await validatePlan(await generatePlan(input), input);
      job.status = "done";
      console.log(
        `[job] ${job.id} 完成 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 预警 ${job.plan.warnings.length} 条`,
      );
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : "生成失败，请稍后重试";
      onError?.(); // 失败归还配额
      console.log(`[job] ${job.id} 失败 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 原因=${job.error}`);
    }
  })();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

// 清理 2 小时前的任务，防内存泄漏（任务结果 2 小时内有效）
if (typeof setInterval === "function") {
  setInterval(() => {
    const cutoff = Date.now() - 2 * 3600_000;
    for (const [k, v] of jobs) if (v.createdAt < cutoff) jobs.delete(k);
  }, 600_000).unref?.();
}
