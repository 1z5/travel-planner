import "server-only";
import { randomBytes } from "node:crypto";
import { getStore } from "./store";
import type { Plan, PlanInput } from "./types";
import type { PlanRecord } from "./store/types";

// ============================================================
// 行程（Plan）领域门面：路由只通过这里拿/改行程，不直接碰 Store。
//
// 为什么需要这一层：以前「行程」寄生在 Job 记录里（job.plan），而 Job 是
// 一次性执行记录、TTL 只有 2 小时——于是分享链接 2 小时后就失效、服务重启
// 即丢。现在 Plan 是一等聚合（持久化 + 分享 token + revision），Job 退回为
// 「一次性执行记录」，只保留 shareId 作为指向 Plan 的指针。
//
// 两层兼容（这轮升级的硬约束）：
//   - 新链接：/p/<shareId> → PlanStore
//   - 旧链接：/p/<jobId>   → 2 小时内仍可读 Job 里的 plan（resolvePlan 兜底）
// ============================================================

export type { PlanRecord };

/** 分享 token 前缀：一眼能区分「行程 token」与「任务 id」，排障时不用猜 */
const SHARE_ID_PREFIX = "share_";

/**
 * 生成分享 token（不可猜测，URL-safe）。
 *
 * 为什么不能直接用 job id 当分享 token：
 * 1) 可枚举：job id 是 `job_<毫秒时间戳 base36><4 位随机>`，随机部分只有
 *    ~20 bit。知道大概提交时间就能爆破别人的行程（未授权读取）。
 * 2) 权限混淆：job id 同时是轮询 /api/plan/status 的凭据，拿它当分享 token
 *    等于把「看进度/看错误」的权限也一起分享了。
 * 3) 生命周期错配：job 2 小时就被清理，分享链接不该跟着失效。
 *
 * 72 bit 随机（9 字节 base64url = 12 字符）+ `share_` 前缀。碰撞概率可忽略，
 * 不需要查重（也不该用「先查再写」制造 TOCTOU）。
 */
export function newShareId(): string {
  return `${SHARE_ID_PREFIX}${randomBytes(9).toString("base64url")}`;
}

/**
 * 生成完成后把行程落为持久 Plan，返回分享 token；失败返回 null。
 *
 * 幂等：同一 jobId 重复调用返回同一个 token、不产生第二份 Plan。判重依据是
 * JobRecord.shareId——PlanStore 没有 jobId 索引（不为一个反查字段建索引/加唯一
 * 约束），任务记录才是「这个 job 是否已交付分享链接」的权威。
 *
 * 失败处理（明确取舍）：**不阻断主流程**。落库失败只记日志、返回 null，
 * 任务照常标 done——用户等了 4 分钟，行程本体已经生成好了，不能因为一次
 * 数据库抖动把成果判失败。代价是这一次没有分享/日历链接，前端据
 * `shareId === null` 隐藏分享按钮（诚实降级，不给打不开的链接）。
 *
 * 已知窄缝（可接受）：save 成功但回写 job.shareId 失败时，Plan 已存在而任务
 * 没有指针；重放会再生成一个新 token（旧记录成为无人引用的孤儿，30 天后被
 * 清理）。数据无损坏，代价是一次失败后的重放可能多一份孤儿记录。
 */
export async function commitPlan(
  jobId: string,
  plan: Plan,
  input: PlanInput,
  ownerKey?: string,
): Promise<string | null> {
  const store = getStore();
  try {
    const job = await store.jobs.get(jobId);
    if (job?.shareId) return job.shareId;

    const now = Date.now();
    const record: PlanRecord = {
      id: newShareId(),
      jobId,
      ownerKey,
      plan,
      input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await store.plans.save(record);
    // 回写 job：前端轮询到 done 时同一响应里就能拿到 shareId
    await store.jobs.update(jobId, { shareId: record.id });
    console.log(
      `[plan-repo] ${jobId} 行程已持久化 shareId=${record.id}（${plan.city} ${plan.days.length} 天）`,
    );
    return record.id;
  } catch (e) {
    console.error(
      `[plan-repo] ${jobId} 行程持久化失败（任务继续 done，分享链接缺省）: ${(e as Error).message}`,
    );
    return null;
  }
}

/** 按分享 token 读行程（新链接路径）；不存在返回 null */
export async function getSharedPlan(id: string): Promise<Plan | null> {
  const record = await getStore().plans.get(id);
  return record?.plan ?? null;
}

/**
 * 读可编辑的行程记录（含 input，改行程要用它重跑体检/提示）。
 *
 * 只对持久化 Plan 开放：旧 job 链接是只读的历史结果，没有 input/owner 语义，
 * 在 Job 上原地改会破坏「Job 是一次性执行记录」的模型。
 */
export async function getPlanForEdit(id: string): Promise<PlanRecord | null> {
  return getStore().plans.get(id);
}

/**
 * 替换行程内容（改行程）：revision+1、updatedAt 刷新。
 *
 * 返回 null 表示分享链接不存在（路由应回 404）。并发两次修改时 revision 由
 * Store 层原子自增（postgres 用数据库 increment），不会丢更新；本轮接口的
 * 语义是「最后写入生效」，不对外暴露 If-Match 冲突检测（由 refine 决定是否加）。
 */
export async function replacePlan(id: string, plan: Plan): Promise<PlanRecord | null> {
  return getStore().plans.replace(id, plan);
}

/**
 * 统一读行程入口（分享页 / OG / .ics 都用它）：
 * 先查 PlanStore（新链接），再兜底查 Job（旧链接向后兼容）。
 *
 * 为什么保留 Job 兜底：升级前已经发出去的 /p/<jobId> 链接、以及现有 e2e
 * 都直接拿 jobId 访问分享页。只要任务还在 2 小时 TTL 内就照常可读；
 * 超过 TTL 才失效——这比升级前「一律 2 小时失效」严格更好，不回归。
 */
export async function resolvePlan(id: string): Promise<Plan | null> {
  const store = getStore();
  const record = await store.plans.get(id);
  if (record) return record.plan;

  const job = await store.jobs.get(id);
  if (job?.status === "done" && job.plan) return job.plan;
  return null;
}
