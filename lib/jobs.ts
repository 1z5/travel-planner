import "server-only";
import { generatePlan } from "./planner";
import { validatePlan } from "./validate";
import { getStore } from "./store";
import type { PlanInput } from "./types";

// ============================================================
// 异步任务：提交即返回 jobId，生成在后台进行，前端轮询进度。
// 状态经 Store 门面持久化（memory 默认 / postgres 可选）。
// ============================================================

function newId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function getJob(id: string) {
  return getStore().jobs.get(id);
}

export async function createJob(
  input: PlanInput,
  key: string,
  limit: number,
  onError?: () => void,
) {
  const store = getStore();
  const job = {
    id: newId(),
    status: "running" as const,
    key,
    limit,
    createdAt: Date.now(),
  };
  await store.jobs.create(job);
  console.log(
    `[job] ${job.id} 开始 城市=${input.city} 天数=${input.days} 预算=${input.budget}`,
  );
  void (async () => {
    const t0 = Date.now();
    try {
      const plan = await validatePlan(await generatePlan(input), input);
      await store.jobs.update(job.id, { status: "done", plan });
      console.log(
        `[job] ${job.id} 完成 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 预警 ${plan.warnings.length} 条`,
      );
    } catch (e) {
      const error = e instanceof Error ? e.message : "生成失败，请稍后重试";
      await store.jobs.update(job.id, { status: "error", error });
      onError?.(); // 失败归还配额
      console.log(`[job] ${job.id} 失败 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 原因=${error}`);
    }
  })();
  return job;
}
