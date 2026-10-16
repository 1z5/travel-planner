import "server-only";
import { generatePlan, generateOutline, generateDay } from "./planner";
import { validatePlan, validateDay, finalizePlan } from "./validate";
import { AMAP_MOCK } from "./amap";
import { getStore } from "./store";
import type { Plan, PlanDay, PlanInput, PlanSpot } from "./types";
import type { Store } from "./store";

// ============================================================
// 异步任务：提交即返回 jobId，生成在后台进行，前端轮询进度。
// 状态经 Store 门面持久化（memory 默认 / postgres 可选）。
//
// 按天数分流两条生成路径：
//   < 5 天：单次调用生成完整行程（已验证的质量路径，行为不变）
//   ≥5 天：大纲 → 逐日生成，每完成一天就增量更新 job.plan，
//           让用户逐天看到结果而不是干等一个总 deadline
// ============================================================

/** ≥5 天走分日流式（单次调用在这个长度必爆 token） */
const STREAMING_MIN_DAYS = 5;

function newId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 深拷贝 plan：memory store 存的是引用，不拷贝的话前端会读到半成品状态 */
function clonePlan(plan: Plan): Plan {
  return { ...plan, days: plan.days.map((d) => ({ ...d, spots: d.spots.map((s) => ({ ...s })) })) };
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
      if (input.days >= STREAMING_MIN_DAYS) {
        await runStreaming(store, job.id, input);
      } else {
        const plan = await validatePlan(await generatePlan(input), input);
        await store.jobs.update(job.id, { status: "done", plan });
      }
      console.log(
        `[job] ${job.id} 完成 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`,
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

/**
 * 分日流式（≥5 天）：先出大纲让用户立刻看到骨架，再逐日生成+体检，
 * 每完成一天就增量落库（status 仍为 running，plan 里带已生成的天）。
 *
 * 串行而非并发的理由：
 * 1. 天数必须按序呈现——并发下第 2 天可能比第 1 天先完成，用户会看到乱序
 * 2. 避开 LLM 速率限制（个人 key 并发打满会更慢，甚至触发限流）
 * 3. 5 天约 3-4 分钟，与 4 天单次调用耗时相当，UX 收益已经拿到
 */
async function runStreaming(store: Store, jobId: string, input: PlanInput): Promise<void> {
  const t0 = Date.now();
  const outline = await generateOutline(input);

  // 骨架 plan：大纲一出来就落库，前端可立即展示概览与「即将生成 N 天」
  const plan: Plan = {
    city: outline.city,
    summary: outline.summary,
    days: [],
    totalCostCny: 0,
    tips: outline.tips,
    warnings: [],
    verified: false,
    // 流式进行中的验真状态：接了小德 key 就显示"验真进行中"，
    // 不能沿用 verified=false（那会让徽章误报「MOCK 模式：未接高德」）
    verification: AMAP_MOCK ? "mock" : "pending",
    startDate: input.startAt?.slice(0, 10),
    endDate: input.endAt?.slice(0, 10),
    startAt: input.startAt,
    endAt: input.endAt,
  };
  await store.jobs.update(jobId, { plan: clonePlan(plan) });
  console.log(
    `[job] ${jobId} 大纲完成 ${((Date.now() - t0) / 1000).toFixed(1)}s（${outline.days.length} 天），开始逐日生成`,
  );

  const warnings: string[] = [];
  const unverified: string[] = [];
  const transitUnknownDays: number[] = [];
  let grandTotal = 0;

  for (let i = 0; i < outline.days.length; i++) {
    const tDay = Date.now();
    try {
      const raw = await generateDay(input, outline, i);
      const day: PlanDay = {
        ...raw,
        spots: raw.spots as PlanSpot[],
        transitMin: 0,
        dailyCostCny: 0,
      };
      // 单日体检：预警随天数一起出现，不用等全量生成完
      const check = await validateDay(plan, day, input);
      plan.days.push(day);
      warnings.push(...check.warnings);
      unverified.push(...check.unverified);
      if (check.transitUnknown) transitUnknownDays.push(day.day);
      grandTotal += day.dailyCostCny;
      plan.warnings = [...warnings];

      await store.jobs.update(jobId, { plan: clonePlan(plan) });
      console.log(
        `[job] ${jobId} 第 ${day.day} 天完成 ${((Date.now() - tDay) / 1000).toFixed(1)}s（累计 ${plan.days.length}/${outline.days.length} 天）`,
      );
    } catch (e) {
      // 失败信息必须带上进度。实测踩过：第 4 天连接被掐断时只抛出一个
      // "terminated"，用户等了 14 分钟却完全无法行动——不知道成了几天、
      // 不知道该不该重试。这里把进度与「配额已退还」说清楚。
      const reason = e instanceof Error ? e.message : "生成失败";
      throw new Error(
        `第 ${i + 1} 天生成失败：${reason}（已成功生成 ${plan.days.length} 天，配额已退还，可重试）`,
      );
    }
  }

  // 收尾：预算核对 + 必游地/住所核验 + 验真完成度 + 系统提示
  finalizePlan(plan, input, { warnings, unverified, transitUnknownDays, grandTotal });
  await store.jobs.update(jobId, { status: "done", plan: clonePlan(plan) });
}
