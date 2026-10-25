import "server-only";
import { generatePlan, generateOutline, generateDay } from "./planner";
import { generateDraftPlan } from "./draft-plan";
import { buildFastDraft, isPublishableFastDraft } from "./fast-draft";
import {
  collectGrounding,
  groundingSummary,
  groundingSummaryOf,
  type Grounding,
} from "./grounding";
import { validatePlan, validateDay, finalizePlan, type DayCheck } from "./validate";
import { mapLimit } from "./concurrency";
import { AMAP_MOCK } from "./amap";
import { getStore } from "./store";
import { commitPlan } from "./plan-repo";
import { refund } from "./ratelimit";
import { fetchWeather, buildWeatherAdvice } from "./weather";
import type { Plan, PlanDay, PlanInput, PlanSpot } from "./types";
import type { JobRecord, Store } from "./store";

// ============================================================
// 异步任务：提交即返回 jobId，生成在后台进行，前端轮询进度。
// 状态经 Store 门面持久化（memory 默认 / postgres 可选）。
//
// 按天数分流两条生成路径：
//   < 5 天：单次调用生成完整行程（实测比同长度分日更快，见 STREAMING_MIN_DAYS）
//   ≥5 天：大纲 → 逐日生成，每完成一天就增量更新 job.plan，
//           让用户逐天看到结果而不是干等一个总 deadline
// ============================================================

/**
 * ≥N 天走分日流式。**默认 5，是用实测数据换回来的**（2026-10-25）：
 *
 * 曾假设「分日后每次调用只想一天，3 路并发下墙钟≈最慢的一天」，把阈值降到 2
 * 跑了一轮。同参数实测（杭州 3 天 / 预算 3000 / 两个偏好）：
 *   - 单次调用（阈值 5）：**279.1s**
 *   - 分日流式（阈值 2）：**336.2s**（大纲 66.3s + 逐日约 270s）
 * 分日并没有变快：大纲是净开销，逐日调用的总时长≈单次（网关基本串行消化并发，
 * 每次调用各自的 prompt 开销还在）。分日的真实价值在 **5 天以上**——那时单次
 * 调用必爆 token/超时，分日是唯一可行路径，且「首日先可见」的收益明显。
 *
 * 所以：2-4 天保持单次（更快，跨天一致性也更好），≥5 天走分日。
 * env 可覆盖（以后网关并发变强时再测）：STREAMING_MIN_DAYS=2 即当时的分日实验。
 */
const STREAMING_MIN_DAYS = Number(process.env.STREAMING_MIN_DAYS || 5);

/** 轻量心跳间隔：任务运行期间每 60s 打一次空 update，刷新 JobRecord.updatedAt */
const HEARTBEAT_MS = 60_000;

// ============================================================
// 阶段遥测（stage）：把「3-5 分钟轮询黑盒」变成「看着行程长出来」。
//
// stage 枚举（管线真实顺序，每条路径只走其中一段）：
//   outline     大纲生成中（≥5 天流式路径：LLM 先出天数主题骨架）
//   grounding   取事实清单中（高德 POI/营业时间/闭馆日，两条路径都有）
//   day:N/M     逐日生成/验真/发布中（≥5 天；N=已发布天数，M=总天数）
//   generating  单次调用生成完整行程中（≤4 天；真正的长等待在这里）
//   verify      POI 验真 + 体检中（validatePlan/validateDay）
//   finalizing  收尾：计划级体检汇总 + 天气提示 + 持久化
//   done        完成（终态；status 路由只对 running 任务透传 stage）
//
// 为什么存在进程内 Map 而不是 JobRecord 字段：postgres 实现的 update 是
// 字段白名单（见 store/postgres.ts），加列要动 Prisma schema 并重新
// generate——那是存储层的一次迁移，不属于本切片的改动范围。进程内 Map
// （挂 globalThis，与 memory store 同一理由：dev 下模块重复实例化会丢
// 状态）覆盖默认部署（单进程 memory）；多实例 postgres 下若状态请求落到
// 非执行实例，遥测缺失 → 前端降级为不确定进度条（诚实：不知道就不猜）。
// ============================================================

export type JobStage =
  | "outline"
  | "grounding"
  | "generating"
  | "verify"
  | "finalizing"
  | "done"
  | `day:${number}/${number}`;

const gStages = globalThis as typeof globalThis & {
  __tpJobStages?: Map<string, { stage: JobStage; at: number }>;
};
const jobStages = (gStages.__tpJobStages ??= new Map<string, { stage: JobStage; at: number }>());

/** 任务 TTL 同口径（memory store 2 小时）：顺带清掉过期条目，防常驻进程内存增长 */
const STAGE_TTL_MS = 2 * 3600_000;

/** 写入当前阶段。只在管线**真实经过**该位置时调用——遥测撒谎比没有遥测更糟 */
export function setStage(jobId: string, stage: JobStage): void {
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const [k, v] of jobStages) if (v.at < cutoff) jobStages.delete(k);
  jobStages.set(jobId, { stage, at: Date.now() });
}

/** 读取当前阶段；未知/旧任务（升级前创建的）返回 undefined */
export function getJobStage(jobId: string): JobStage | undefined {
  return jobStages.get(jobId)?.stage;
}

/** 任务终止（失败/中断）时清除遥测：僵死任务不该留着一个假装还在跑的阶段 */
export function clearStage(jobId: string): void {
  jobStages.delete(jobId);
}

/**
 * 逐日阶段标签：`day:N/M`（N=已发布天数，M=总天数）。
 *
 * 抽成函数是为了把格式契约钉死在一处：前端按 `day:N/M` 解析确定性进度，
 * 两端口径必须一致（单测见 tests/lib/jobs.test.ts）。
 */
export function dayStage(published: number, total: number): JobStage {
  return `day:${published}/${total}`;
}

/**
 * 陈旧任务阈值：running 任务超过这么久没有心跳，就认为生成它的进程已经不在了
 * （服务重启 / 容器被回收 / 进程冻结）。默认 12 分钟，JOB_STALE_MS 可覆盖。
 *
 * 为什么 12 分钟够安全：
 * - 两条生成路径都有 60s 心跳（streaming 的逐日落库本身也是心跳），
 *   12 分钟 = 连续丢 12 次心跳，正常运行的进程不会发生
 * - 正常生成时长 2-8 分钟（跨境 8 分钟+），远小于 12 分钟
 * - 阈值再大（如 20 分钟）会让用户在服务重启后对着僵尸任务白等更久；
 *   阈值太小则有误杀正常长任务的风险。12 分钟取在两者之间。
 */
export function staleJobMs(): number {
  const raw = Number(process.env.JOB_STALE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 12 * 60_000;
}

/** 任务被判定中断时给用户看的错误（写清楚原因与下一步，不假装任务还在跑） */
export const JOB_INTERRUPTED_ERROR = "生成已中断（服务重启或长时间无响应），请重新生成";

/** running 且超过 staleJobMs 无心跳 → 视为中断（可注入 now 便于测试） */
export function isJobStale(job: JobRecord, now = Date.now()): boolean {
  if (job.status !== "running") return false;
  return now - (job.updatedAt ?? job.createdAt) > staleJobMs();
}

// 进程内已退配额的 job id：并发轮询请求可能同时发现同一个僵尸任务，
// 同步登记保证只有第一个请求退配额（多实例 postgres 下仍有极小概率双退，
// 但代价只是多一次免费生成，不影响正确性，见最终报告的遗留风险）
const refundedInterrupted = new Set<string>();

/**
 * 把僵尸 running 任务置为 error 并退还配额。
 *
 * 为什么退配额：这次失败不是用户操作造成的（是我们的进程没了），
 * 和正常失败路径「失败退还配额」保持同一原则——不能因为服务重启吞掉用户的次数。
 */
export async function interruptJob(job: JobRecord): Promise<void> {
  if (refundedInterrupted.has(job.id)) return;
  refundedInterrupted.add(job.id); // 先同步登记再 await，避免并发双退
  clearStage(job.id); // 遥测跟着任务一起死：不留假装在跑的阶段
  await getStore().jobs.update(job.id, { status: "error", error: JOB_INTERRUPTED_ERROR });
  await refund(job.key);
  console.log(
    `[job] ${job.id} 判定为中断（超过 ${Math.round(staleJobMs() / 1000)}s 无心跳），已退还配额`,
  );
}

/**
 * 心跳：每 60s 打一次空 update（Store 实现保证刷新 updatedAt）。
 * 返回停止函数，必须在生成结束（成功/失败）时调用，避免定时器泄漏。
 */
function startHeartbeat(store: Store, jobId: string): () => void {
  const timer = setInterval(() => {
    void store.jobs.update(jobId, {}).catch((e) => {
      // 心跳失败只记日志：它是保活信号，不该影响生成本身
      console.log(`[job] ${jobId} 心跳写入失败（忽略）: ${(e as Error).message}`);
    });
  }, HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function newId(): string {
  return `job_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 收尾并标记完成：追加天气风险提示，把行程持久化为 Plan 聚合，然后落库为 done。
 *
 * 天气是增强不是门槛——查询失败（无 key / 超出预报窗口 / 上游异常）时
 * 静默跳过，绝不让整个任务失败。用户拿到的是「没有天气提示的行程」，
 * 而不是「生成失败」。
 *
 * 顺序是「先 commitPlan 拿到 shareId，再写 done」：前端第一次轮询到 done 时
 * 必须同时拿到 shareId（否则会停在「没有分享按钮」——done 之后前端不再轮询，
 * 迟到的 shareId 永远送不到）。commitPlan 内部失败只降级返回 null，不阻断交付。
 */
/**
 * 核验差异报告：秒级初版 → 精排版之间，核验层**实际**做了什么。
 *
 * 为什么需要：我们的核心价值是「核验」，但用户看不到核验发生了什么——这是
 * 「不如豆包」感知的一部分（豆包快，我们慢且说不出慢在哪里）。这份报告把
 * 3 分钟的等待换成一句可验证的话：「12 个 POI 已核实存在、避开 1 个闭馆日、
 * 34 段真实通勤、修正 5 处时间接不上」。
 *
 * 诚实口径：只报真实发生的事——没有初版（无 grounding）时返回 undefined，
 * 前端整块不渲染，不用估计值填充。
 */
function buildVerificationReport(
  fastDraft: Plan | undefined,
  finalPlan: Plan,
  gSummary: ReturnType<typeof groundingSummary>,
): Plan["verificationReport"] {
  if (!fastDraft) return undefined;
  const fastNames = fastDraft.days.flatMap((d) => d.spots.map((s) => s.name));
  if (!fastNames.length) return undefined;
  const finalNames = finalPlan.days.flatMap((d) => d.spots.map((s) => s.name));
  // 保留 = 初版的点在精排版里仍出现（双向包含即可：模型可能补全名称）
  const keptInFinal = fastNames.filter((n) =>
    finalNames.some((f) => f.includes(n) || n.includes(f)),
  ).length;
  const realLegs = finalPlan.days.reduce((n, d) => n + (d.legs?.length ?? 0), 0);
  // 初版没有通勤数据（transitMin=0、无 legs），所以「时间接不上」的修正数
  // 用真实路段数近似——不假装我们逐段比对了（没有依据就不下判断）。
  return {
    fastDraftSpots: fastNames.length,
    keptInFinal,
    closedSkipped: gSummary?.closedSkipped ?? 0,
    closedOut: gSummary?.closedOut ?? 0,
    realLegs,
    timeFixed: realLegs,
  };
}

async function completeWithWeather(
  store: Store,
  jobId: string,
  plan: Plan,
  input: PlanInput,
  ownerKey?: string,
): Promise<void> {
  try {
    const advice = await buildWeatherAdvice(plan, await fetchWeather(plan.city));
    if (advice.warnings.length) {
      plan.warnings.push(...advice.warnings);
      console.log(
        `[job] ${jobId} 天气提示 ${advice.warnings.length} 条（预报覆盖 ${advice.coveredDays}/${plan.days.length} 天）`,
      );
    }
  } catch (e) {
    console.log(`[job] ${jobId} 天气查询失败（已跳过）: ${(e as Error).message}`);
  }
  const snapshot = clonePlan(plan);
  // 行程持久化：失败只意味着「这次没有分享链接」，行程本体照常交付
  const shareId = await commitPlan(jobId, snapshot, input, ownerKey);
  // 埋点：生成完成。用 store.events（memory/postgres 双实现），失败不影响交付。
  await store.events.record({
    id: `ev_${jobId}`,
    name: "plan_created",
    shareId: shareId ?? undefined,
    city: plan.city,
    day: plan.days.length,
    createdAt: Date.now(),
  });
  // 一次写入同时落 done + plan + shareId：轮询到 done 即拿到完整结果
  await store.jobs.update(jobId, {
    status: "done",
    plan: snapshot,
    ...(shareId ? { shareId } : {}),
  });
  // 遥测收口到 done（终态）。写在落库之后：状态请求以 status=done 为准，
  // 这条 stage 只让遥测序列完整（供日志/排查看「管线最后停在哪」）。
  setStage(jobId, "done");
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

/**
 * 取事实清单（事实先行的原料）：真实 POI + 真实营业时间 + 闭馆日。
 *
 * **永远不能阻断生成**：新增能力必须是无单点故障的增强。拿不到清单时
 * 返回 undefined，生成链路退回「盲写 + 体检兜底」的老路径——那依然能出
 * 行程，只是闭馆日之类的冲突要等体检报出来。
 */
async function safeGrounding(
  input: PlanInput,
  opts?: { extraKeywords?: string[]; seed?: Grounding["candidates"] },
): Promise<Grounding | undefined> {
  try {
    const g = await collectGrounding(input, opts);
    if (g.state !== "ok") {
      console.log(`[job] 事实清单不可用（${g.state}）：${g.note ?? "无候选"}——退回常规生成`);
      return undefined;
    }
    const closed = g.candidates.filter((c) => c.closedOn).length;
    console.log(
      `[job] 事实清单就绪：${g.candidates.length} 个候选（检索 ${g.queries.length} 组关键词，其中 ${closed} 个含闭馆日已标注）`,
    );
    return g;
  } catch (e) {
    console.log(`[job] 事实清单采集异常（已跳过，不影响生成）：${(e as Error).message}`);
    return undefined;
  }
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
  console.log(`[job] ${job.id} 开始 城市=${input.city} 天数=${input.days} 预算=${input.budget}`);
  void (async () => {
    const t0 = Date.now();
    // 心跳保活：running 任务必须持续刷新 updatedAt，否则服务重启后 status 路由
    // 的陈旧判定会误杀，或（没心跳时）用户要白等一整段阈值才发现任务已死。
    const stopHeartbeat = startHeartbeat(store, job.id);
    try {
      if (input.days >= STREAMING_MIN_DAYS) {
        await runStreaming(store, job.id, input, key);
      } else {
        // 遥测起点（grounding）写在 IIFE 的第一行同步段：它先于任何 await
        // 执行，因此 202 响应返回前 stage 必然已写入——轮询永远不会看到
        // 「running 但无遥测」的窗口，旧任务降级只发生在真的没有遥测时。
        setStage(job.id, "grounding");
        // 即时草稿：<100ms 生成结构化预览，用户立即看到行程骨架
        const draft = generateDraftPlan(input);
        await store.jobs.update(job.id, { plan: draft });
        console.log(`[job] ${job.id} 即时草稿已发布（${draft.days.length} 天预览）`);

        // LLM 真实生成（3-5 分钟），完成后替换草稿
        // 事实先行：先把高德的真实素材清单交给模型，再让它排行程
        const tG = Date.now();
        const grounding = await safeGrounding(input);

        // 秒级初版：事实清单就绪（约 2s）就用真实 POI 组装一版可读行程，
        // 让用户在 LLM 思考的 3 分钟里看到真实内容而不是占位骨架。
        // 没有可用候选（未接高德/检索失败）时不发布——不拿假 POI 冒充真实地点。
        let fastDraft: Plan | undefined;
        if (grounding?.state === "ok" && grounding.candidates.length > 0) {
          const fast = buildFastDraft(input, grounding);
          if (isPublishableFastDraft(fast)) {
            fastDraft = fast;
            await store.jobs.update(job.id, { plan: fast });
            console.log(
              `[job] ${job.id} 秒级初版已发布（${fast.days.length} 天 / ${fast.days.reduce(
                (n, d) => n + d.spots.length,
                0,
              )} 个真实 POI，grounding ${Date.now() - tG}ms）`,
            );
          }
        }

        setStage(job.id, "generating"); // 单次路径的长等待全在这一个调用里
        const raw = await generatePlan(input, grounding);
        setStage(job.id, "verify"); // validatePlan = 逐日验真 + 体检 + 计划级汇总
        const plan = await validatePlan(raw, input);
        const gSummary = groundingSummary(grounding);
        plan.grounding = gSummary;
        // 核验差异报告：初版 → 精排版之间核验层实际做了什么（每个数字可溯源）
        plan.verificationReport = buildVerificationReport(fastDraft, plan, gSummary);
        setStage(job.id, "finalizing"); // 收尾：天气提示 + 持久化 + done
        await completeWithWeather(store, job.id, plan, input, key);
      }
      console.log(`[job] ${job.id} 完成 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      const error = e instanceof Error ? e.message : "生成失败，请稍后重试";
      await store.jobs.update(job.id, { status: "error", error });
      clearStage(job.id); // 失败即终态：遥测清掉，不留假装在跑的阶段
      onError?.(); // 失败归还配额
      console.log(
        `[job] ${job.id} 失败 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s 原因=${error}`,
      );
    } finally {
      stopHeartbeat();
    }
  })();
  return job;
}

/**
 * 分日流式（≥5 天）：先出大纲让用户立刻看到骨架，再逐日生成+体检，
 * 每完成一天就增量落库（status 仍为 running，plan 里带已生成的天）。
 *
 * 并发 3 路 + **前缀发布**：并发出场顺序不固定（第 3 天可能比第 2 天先完成），
 * 所以只有「连续已完成」的天才会推给用户——未就绪的天挡住它后面的所有天，
 * 用户永远看不到乱序行程。3 路是实测的甜点（网关 3 路总耗时 ≈ 单次），
 * 再高会逼近个人 key 的限流阈值。
 */
async function runStreaming(
  store: Store,
  jobId: string,
  input: PlanInput,
  ownerKey?: string,
): Promise<void> {
  const t0 = Date.now();
  // 秒级初版的引用：发布后 job.plan 会被逐日快照覆盖，但核验报告要拿它做对比
  const fastDraftRef: { plan?: Plan } = {};
  // 遥测起点（outline）是函数的第一个同步语句：runStreaming 由 createJob 的
  // IIFE 在同步段里 await 调用，因此它先于 202 响应执行——轮询从第一帧起
  // 就能看到阶段，不存在「running 但无遥测」的窗口。
  setStage(jobId, "outline");
  const outline = await generateOutline(input);

  // 事实先行（多天）：城市级清单是主力——模型要跨天分配地点，得先看见全城
  // 有哪些真实可用的点；每天再按主题/区域补一轮，作为当天的加权补充。
  setStage(jobId, "grounding");
  const cityGrounding = await safeGrounding(input);
  const dayGrounding = new Map<number, Grounding | undefined>();
  await mapLimit(
    outline.days.map((_, i) => i),
    2,
    async (i) => {
      const d = outline.days[i];
      dayGrounding.set(
        i,
        await safeGrounding(input, {
          extraKeywords: [d.theme, d.area],
          seed: cityGrounding?.candidates,
        }),
      );
    },
  );

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

  // 这里**不发布秒级初版**（曾发布过，实测回退）：
  // 流式路径的已发布天数是「只增不减」的前缀（e2e 有专项断言 daysReady 单调），
  // 而初版一次性带 N 天 → 用户会看到 0 天 → N 天 → 1 天的回退，比没有初版更糟。
  // 流式路径本身的体验已经够好：大纲骨架（<1s）+ 逐日生长（第 1 天约 1 分钟可见）。
  // 秒级初版只服务「单次路径」——那才是 3 分钟黑盒、需要立刻看到真实内容的场景。

  console.log(
    `[job] ${jobId} 大纲完成 ${((Date.now() - t0) / 1000).toFixed(1)}s（${outline.days.length} 天），开始逐日生成`,
  );

  const warnings: string[] = [];
  const unverified: string[] = [];
  const transitUnknownDays: number[] = [];
  let grandTotal = 0;

  // 遥测进入逐日阶段（还没有任何一天就绪：day:0/M）。M 用大纲的真实天数
  // （管线口径），不拿用户输入的天数冒充——两者不一致时以管线为准。
  setStage(jobId, dayStage(0, outline.days.length));

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
    // 遥测在快照**落库之后**再写：反过来写会出现「stage=day:2/5 但
    // daysReady=1」的不一致快照（一次轮询正好落在两次写之间）。遥测永远
    // 不领先于真实交付——滞后可接受（下一帧就追平），领先就是撒谎。
    setStage(jobId, dayStage(published, outline.days.length));
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
        const raw = await generateDay(input, outline, i, dayGrounding.get(i));
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

  // 收尾：预算核对 + 必游地/住所核验 + 验真完成度 + 系统提示。
  // missCount / poiTotal 供 finalizePlan 判断「无覆盖区域」（境外目的地）：
  // 逐条 warning 里已含当天 miss 信息，这里按全局汇总即可。
  setStage(jobId, "finalizing"); // 逐日阶段结束：进入计划级汇总 + 天气 + 持久化
  const poiTotal = plan.days.reduce(
    (n, d) => n + d.spots.filter((s) => s.type === "sight" || s.type === "food").length,
    0,
  );
  const missCount = warnings.filter((w) => w.includes("未在高德检索到")).length;
  finalizePlan(plan, input, {
    warnings,
    unverified,
    transitUnknownDays,
    grandTotal,
    missCount,
    poiTotal,
  });
  // 事实先行摘要（城市级 + 各天清单的并集）
  const gSummary = groundingSummaryOf([cityGrounding, ...[...dayGrounding.values()]]);
  plan.grounding = gSummary;
  // 核验差异报告（与单次路径同口径）：把「初版 → 精排版」之间核验层实际做过的
  // 事讲清楚。流式路径同样发布了秒级初版，所以同样有话可说。
  plan.verificationReport = buildVerificationReport(fastDraftRef.plan, plan, gSummary);
  // 天气提示 + 持久化分享 + 标记完成（共用逻辑，与单次路径一致）
  await completeWithWeather(store, jobId, plan, input, ownerKey);
}
