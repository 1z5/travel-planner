import "server-only";
import { generatePlan, generateOutline, generateDay } from "./planner";
import { validatePlan, validateDay, finalizePlan, type DayCheck } from "./validate";
import { mapLimit } from "./concurrency";
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

/**
 * 构造「某一天失败」的错误信息。
 *
 * phase 必须是真实失败阶段（生成/体检/进度保存）。实测踩过的教训：早期把三段
 * 操作（生成 → 体检 → 落库）的失败一律说成「生成失败」，用户据此判断"模型没
 * 产出，重试试试"——但如果是体检或落库失败，重试毫无用处（数据库抖动重试
 * 一百次也不会好）。错误信息要能指导用户的下一步动作。
 *
 * 抽成独立函数是为了可单测：这三个阶段在 MOCK 模式下都无法通过桩触发
 * （DaySchema 挡住畸形数据、内存 store 不会失败），e2e 覆盖不到。
 */
export function dayFailureError(
  dayIdx: number,
  phase: string,
  e: unknown,
  published: number,
): Error {
  const reason = reasonOf(e);
  return new Error(
    `第 ${dayIdx + 1} 天${phase}失败：${reason}（已成功生成 ${published} 天，配额已退还，可重试）`,
  );
}

/** 从任意抛出值里提取可读原因：Error 取 message，字符串原样，其余转 JSON */
function reasonOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e); // 循环引用等 JSON.stringify 会抛的情况
  }
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

  // 有界并发生成多天。已实测 LLM 网关的并发能力（3 路并发总耗时 2.8s ≈
  // 单次 1.8s，远小于 3×单次），取 3 路：5-7 天的串行 5-7 波可压到 2-3 波，
  // 把总等待从 10-15 分钟降到约一半。不取更高是不想逼近限流阈值。
  const DAY_CONCURRENCY = 3;

  // 结果按下标存放（不是 push）——并发出场顺序不固定，必须靠下标还原天数顺序
  const dayResults: Array<{ day: PlanDay; check: DayCheck } | null> = [];
  let published = 0; // 已发布给用户的天数（只增不减，保证前端看到的天数连续）
  // 写库串行化链：保证 plan 快照的落地顺序与发布顺序一致（见 publishReady 注释）
  let updateChain: Promise<void> = Promise.resolve();

  const publishReady = async () => {
    // 前缀发布：从 published 起把「连续已完成」的天一次性推出去。
    // 关键在「连续」——第 3 天可能比第 2 天先完成，但用户不能看到乱序行程，
    // 所以未就绪的天会挡住它后面的所有天。
    // 注意 while 循环内没有 await，整个循环是原子的，不会被打断。
    let advanced = false;
    while (published < outline.days.length && dayResults[published]) {
      const r = dayResults[published]!;
      plan.days.push(r.day);
      warnings.push(...r.check.warnings);
      unverified.push(...r.check.unverified);
      if (r.check.transitUnknown) transitUnknownDays.push(r.day.day);
      grandTotal += r.day.dailyCostCny;
      published += 1;
      advanced = true;
    }
    // 没有新发布的天就不写库：plan 未变，写了也是浪费（并发下很常见——
    // 某一天生成完了但它前面的天还没好，前缀推不动）
    if (!advanced) return;

    plan.warnings = [...warnings];
    // 快照必须在同步阶段取：此时 plan.days 已是本次发布的最终状态
    const snapshot = clonePlan(plan);
    // 串行化写库。并发下多个 worker 可能几乎同时发布，若两次 update 乱序
    // 落地（旧快照晚于新快照写入），前端会看到天数回退、daysReady 非单调。
    // 链式等待保证落地顺序与发布顺序一致。
    updateChain = updateChain.then(() => store.jobs.update(jobId, { plan: snapshot }));
    await updateChain;
  };

  await mapLimit(
    outline.days.map((_, i) => i),
    DAY_CONCURRENCY,
    async (i) => {
      const tDay = Date.now();
      // phase 标记当前阶段：失败信息必须说清「哪一步」失败，不能一律说
      // 「生成失败」。实测踩过的教训——用户看到「生成失败」会判断"模型没
      // 产出，重试试试"，但如果是体检或落库失败，重试毫无用处（数据库抖动
      // 重试一百次也不会好）。错误信息要能指导用户的下一步动作。
      let phase = "生成";
      try {
        const raw = await generateDay(input, outline, i);
        const day: PlanDay = {
          ...raw,
          spots: raw.spots as PlanSpot[],
          transitMin: 0,
          dailyCostCny: 0,
        };
        phase = "体检";
        // 单日体检：预警随天数一起出现，不用等全量生成完
        const check = await validateDay(plan, day, input);
        dayResults[i] = { day, check };
        phase = "进度保存";
        await publishReady();
        console.log(
          `[job] ${jobId} 第 ${day.day} 天${phase}完 ${((Date.now() - tDay) / 1000).toFixed(1)}s（已发布 ${published}/${outline.days.length} 天）`,
        );
      } catch (e) {
        // 失败信息必须带上进度与阶段（见 dayFailureError 的注释）
        throw dayFailureError(i, phase, e, published);
      }
    },
  );

  // 收尾：预算核对 + 必游地/住所核验 + 验真完成度 + 系统提示
  finalizePlan(plan, input, { warnings, unverified, transitUnknownDays, grandTotal });
  await store.jobs.update(jobId, { status: "done", plan: clonePlan(plan) });
}
