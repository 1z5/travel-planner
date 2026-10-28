import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStore } from "@/lib/store/memory";
import { getStore } from "@/lib/store";
import { isJobStale, interruptJob, JOB_INTERRUPTED_ERROR, staleJobMs } from "@/lib/jobs";
import { consume, peek } from "@/lib/ratelimit";
import type { JobRecord } from "@/lib/store/types";
import {
  commitPlan,
  getPlanForEdit,
  getSharedPlan,
  jobLinkFallbackEnabled,
  newShareId,
  replacePlan,
  resolvePlan,
} from "@/lib/plan-repo";
import type { Plan, PlanInput } from "@/lib/types";

// ============================================================
// Plan 聚合（本轮架构升级的核心）：内存 store 契约 + plan-repo 领域门面。
//
// 为什么单测而不是只靠 e2e：这些是不变量（幂等、revision 递增、旧链接兜底、
// 落库失败降级），e2e 只能看到「正常链路能点开分享页」，覆盖不到失败分支；
// 而失败分支恰恰是「诚实降级」原则最容易被悄悄破坏的地方。
// ============================================================

const INPUT: PlanInput = {
  city: "成都",
  days: 2,
  startAt: "2026-10-10T10:00",
  endAt: "2026-10-11T18:00",
  budget: 2000,
  preferences: ["美食"],
};

function makePlan(summary = "一份测试行程"): Plan {
  return {
    city: "成都",
    startDate: "2026-10-10",
    endDate: "2026-10-11",
    summary,
    days: [
      {
        day: 1,
        theme: "市中心",
        spots: [
          {
            period: "morning",
            time: "09:00-11:30",
            type: "sight",
            name: "宽窄巷子",
            area: "青羊区",
            durationMin: 90,
            costCny: 0,
            reason: "老成都街巷代表",
          },
        ],
        transitMin: 10,
        dailyCostCny: 100,
      },
    ],
    totalCostCny: 100,
    tips: ["提前预约"],
    warnings: [],
    verified: false,
  };
}

/** 每个用例用独立 id，避免共享内存 store 的用例间互相污染 */
function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 直接往 store 里造一个任务（commitPlan 需要 job + shareId 判重） */
async function makeJob(overrides: { status?: "running" | "done" | "error"; key?: string } = {}) {
  const id = uniq("job_test");
  await getStore().jobs.create({
    id,
    status: overrides.status ?? "running",
    key: overrides.key ?? "ip:127.0.0.1",
    limit: 3,
    createdAt: Date.now(),
  });
  return id;
}

beforeEach(() => {
  // plan-repo 经 getStore() 选实现：显式锁 memory，避免开发机 .env 里
  // DATA_STORE=postgres 让单测去连数据库
  vi.stubEnv("DATA_STORE", "memory");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------- 内存 PlanStore 契约 ----------

describe("memory PlanStore 契约", () => {
  it("save/get：存入后可按 id 读回完整记录", async () => {
    const id = newShareId();
    const record = {
      id,
      jobId: "job_x",
      ownerKey: "ip:test",
      plan: makePlan(),
      input: INPUT,
      revision: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await memoryStore.plans.save(record);

    const got = await memoryStore.plans.get(id);
    expect(got).not.toBeNull();
    expect(got!.plan.summary).toBe("一份测试行程");
    expect(got!.input.city).toBe("成都");
    expect(got!.ownerKey).toBe("ip:test");
    expect(got!.revision).toBe(1);
  });

  it("get：未知 id 返回 null（不是抛错）", async () => {
    expect(await memoryStore.plans.get(uniq("share_missing"))).toBeNull();
  });

  it("replace：revision+1、刷新 updatedAt、内容更新", async () => {
    const id = newShareId();
    const t0 = Date.now();
    await memoryStore.plans.save({
      id,
      plan: makePlan(),
      input: INPUT,
      revision: 1,
      createdAt: t0,
      updatedAt: t0,
    });

    await new Promise((r) => setTimeout(r, 5)); // 保证时间戳能前进（同毫秒会相等）
    const updated = await memoryStore.plans.replace(id, makePlan("改过的行程"));

    expect(updated).not.toBeNull();
    expect(updated!.revision).toBe(2);
    expect(updated!.plan.summary).toBe("改过的行程");
    expect(updated!.updatedAt).toBeGreaterThan(t0);
    // 原记录被替换（不是只改返回值）
    const again = await memoryStore.plans.get(id);
    expect(again!.revision).toBe(2);
  });

  it("replace：不存在返回 null（业务分支，不抛错）", async () => {
    expect(await memoryStore.plans.replace(uniq("share_missing"), makePlan())).toBeNull();
  });
});

// ---------- shareId 生成规则 ----------

describe("newShareId", () => {
  it("格式：URL-safe 且带 share_ 前缀（与 job id 一眼可区分）", () => {
    const id = newShareId();
    expect(id).toMatch(/^share_[A-Za-z0-9_-]{12}$/);
  });

  it("不可猜测：连续生成的 token 不重复、不含时间戳", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newShareId()));
    expect(ids.size).toBe(200);
    // 旧 job id 形如 job_<毫秒时间戳 base36>…：分享 token 不能把时间戳暴露出去
    const ts36 = Date.now().toString(36).slice(0, 6);
    for (const id of ids) expect(id.slice("share_".length, "share_".length + 6)).not.toBe(ts36);
  });
});

// ---------- plan-repo 门面 ----------

describe("commitPlan", () => {
  it("生成分享 token、回写 job.shareId，并能按 token 读回行程", async () => {
    const jobId = await makeJob();
    const plan = makePlan();
    const shareId = await commitPlan(jobId, plan, INPUT, "ip:127.0.0.1");

    expect(shareId).toMatch(/^share_/);
    // 回写任务记录：status 轮询到 done 时同一响应里就能带 shareId
    const job = await getStore().jobs.get(jobId);
    expect(job!.shareId).toBe(shareId);

    const loaded = await getSharedPlan(shareId!);
    expect(loaded!.city).toBe("成都");
    expect(loaded!.days).toHaveLength(1);
  });

  it("幂等：同一 job 重复 commit 返回同一个 token，不产生第二份行程", async () => {
    const jobId = await makeJob();
    const first = await commitPlan(jobId, makePlan("第一份"), INPUT);
    const second = await commitPlan(jobId, makePlan("第二份"), INPUT);

    expect(second).toBe(first);
    // 第一份内容保持不变（幂等 = 不覆盖、不新增）
    expect((await getSharedPlan(first!))!.summary).toBe("第一份");
  });

  it("ownerKey 落库（为后续「最近行程」预留归属）", async () => {
    const jobId = await makeJob({ key: "u:13800138000" });
    const shareId = await commitPlan(jobId, makePlan(), INPUT, "u:13800138000");
    const record = await getPlanForEdit(shareId!);
    expect(record!.ownerKey).toBe("u:13800138000");
    expect(record!.jobId).toBe(jobId);
    expect(record!.revision).toBe(1);
  });

  it("落库失败 → 返回 null 且任务不因此多出 shareId（诚实降级，不假装成功）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(memoryStore.plans, "save").mockRejectedValueOnce(new Error("db down"));

    const jobId = await makeJob();
    const shareId = await commitPlan(jobId, makePlan(), INPUT, "ip:127.0.0.1");

    expect(shareId).toBeNull();
    expect((await getStore().jobs.get(jobId))!.shareId).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("getSharedPlan / getPlanForEdit / replacePlan", () => {
  it("未知 id 全部返回 null（路由可安全映射 404）", async () => {
    const missing = uniq("share_missing");
    expect(await getSharedPlan(missing)).toBeNull();
    expect(await getPlanForEdit(missing)).toBeNull();
    expect(await replacePlan(missing, makePlan())).toBeNull();
  });

  it("改行程：replacePlan revision 递增且 updatedAt 前进，内容生效", async () => {
    const jobId = await makeJob();
    const shareId = (await commitPlan(jobId, makePlan(), INPUT))!;
    const before = (await getPlanForEdit(shareId))!;

    await new Promise((r) => setTimeout(r, 5));
    const replaced = await replacePlan(shareId, makePlan("改行程后"));

    expect(replaced).not.toBeNull();
    expect(replaced!.revision).toBe(before.revision + 1);
    expect(replaced!.updatedAt).toBeGreaterThan(before.updatedAt);
    // 分享页/ics/OG 一律走 getSharedPlan，必须立刻看到新内容
    expect((await getSharedPlan(shareId))!.summary).toBe("改行程后");
  });
});

describe("resolvePlan（分享页/OG/.ics 的统一入口）", () => {
  it("优先读持久化 Plan（新分享链接）", async () => {
    const jobId = await makeJob();
    const shareId = (await commitPlan(jobId, makePlan("持久化版本"), INPUT))!;
    const resolved = await resolvePlan(shareId);
    expect(resolved!.summary).toBe("持久化版本");
  });

  it("向后兼容：查不到 Plan 时兜底读已完成的 Job（旧 /p/<jobId> 链接不回归）", async () => {
    const jobId = await makeJob({ status: "done" });
    const oldPlan = makePlan("旧任务里的行程");
    await getStore().jobs.update(jobId, { plan: oldPlan, status: "done" });

    const resolved = await resolvePlan(jobId);
    expect(resolved!.summary).toBe("旧任务里的行程");
  });

  it("旧链接兜底只在任务 done 时生效（running 的半成品不当作分享结果）", async () => {
    const jobId = await makeJob({ status: "running" });
    await getStore().jobs.update(jobId, { plan: makePlan("半成品") });
    expect(await resolvePlan(jobId)).toBeNull();
  });

  it("未知 id 返回 null", async () => {
    expect(await resolvePlan(uniq("share_missing"))).toBeNull();
  });
});

// ---------- 旧 job 链接兜底开关（安全审计 R3 收尾） ----------
// 开关只影响「PlanStore 未命中后是否回查 Job」；持久化 Plan 的读取永远不受影响。
describe("JOB_LINK_FALLBACK · 旧 job 链接只读兜底开关", () => {
  it("纯函数解析：缺省/空串/1 开启；0/false/off/no（含大小写/空白）关闭", () => {
    expect(jobLinkFallbackEnabled({})).toBe(true);
    expect(jobLinkFallbackEnabled({ JOB_LINK_FALLBACK: "" })).toBe(true);
    expect(jobLinkFallbackEnabled({ JOB_LINK_FALLBACK: "1" })).toBe(true);
    expect(jobLinkFallbackEnabled({ JOB_LINK_FALLBACK: "true" })).toBe(true);
    for (const off of ["0", "false", "off", "no", "FALSE", " Off ", "No"]) {
      expect(jobLinkFallbackEnabled({ JOB_LINK_FALLBACK: off }), off).toBe(false);
    }
  });

  it("缺省开启：job 链接仍可读（本地/演示/旧部署不回归）", async () => {
    vi.stubEnv("JOB_LINK_FALLBACK", "1");
    const jobId = await makeJob({ status: "done" });
    await getStore().jobs.update(jobId, { plan: makePlan("旧任务里的行程"), status: "done" });
    const resolved = await resolvePlan(jobId);
    expect(resolved?.summary).toBe("旧任务里的行程");
  });

  it("关闭后：job 链接返回 null，但持久化 Plan 照常可读", async () => {
    vi.stubEnv("JOB_LINK_FALLBACK", "0");
    const jobId = await makeJob({ status: "done" });
    await getStore().jobs.update(jobId, { plan: makePlan("旧任务里的行程"), status: "done" });
    expect(await resolvePlan(jobId)).toBeNull();

    // 同一个 Job 已持久化成 Plan（commitPlan）后，分享 token 仍然可读——
    // 开关只收窄「旧链接」，不影响新链接的读路径。
    const shareId = (await commitPlan(jobId, makePlan("持久化版本"), INPUT))!;
    const resolved = await resolvePlan(shareId);
    expect(resolved?.summary).toBe("持久化版本");
  });
});

// ---------- 陈旧任务自愈（心跳阈值） ----------

describe("isJobStale：服务重启后的僵尸 running 任务判定", () => {
  const job = (overrides: Partial<JobRecord>): JobRecord => ({
    id: "job_stale_test",
    status: "running",
    key: "ip:127.0.0.1",
    limit: 3,
    createdAt: 1_000_000,
    ...overrides,
  });

  it("默认阈值 12 分钟；JOB_STALE_MS 可覆盖", () => {
    expect(staleJobMs()).toBe(12 * 60_000);
    vi.stubEnv("JOB_STALE_MS", "60000");
    expect(staleJobMs()).toBe(60_000);
  });

  it("没有心跳时以 createdAt 为基准（兼容旧记录）", () => {
    const now = 1_000_000 + 11 * 60_000; // 提交 11 分钟，无心跳字段
    expect(isJobStale(job({}), now)).toBe(false);
    expect(isJobStale(job({}), now + 2 * 60_000)).toBe(true);
  });

  it("心跳持续刷新时不误杀（正常生成中的任务）", () => {
    const now = 1_000_000 + 60 * 60_000; // 已跑 1 小时
    // 但 30 秒前刚有心跳 → 还活着
    expect(isJobStale(job({ updatedAt: now - 30_000 }), now)).toBe(false);
  });

  it("非 running 状态不参与判定（done/error 不需要自愈）", () => {
    const staleAt = 1_000_000 + 60 * 60_000;
    expect(isJobStale(job({ status: "done", updatedAt: 0 }), staleAt)).toBe(false);
    expect(isJobStale(job({ status: "error", updatedAt: 0 }), staleAt)).toBe(false);
  });

  it("中断文案说清原因与下一步（不假装还在生成）", () => {
    expect(JOB_INTERRUPTED_ERROR).toContain("中断");
    expect(JOB_INTERRUPTED_ERROR).toContain("请重新生成");
  });
});

describe("interruptJob：僵尸任务置 error + 退还配额", () => {
  it("running → error，错误信息写明中断原因", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const id = await makeJob({ status: "running" });
    const record = (await getStore().jobs.get(id))!;

    await interruptJob(record);

    const after = (await getStore().jobs.get(id))!;
    expect(after.status).toBe("error");
    expect(after.error).toBe(JOB_INTERRUPTED_ERROR);
  });

  it("退还配额：任务失败不该吞掉用户的次数（与正常失败路径一致）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const key = `ip:stale-${Math.random().toString(36).slice(2)}`;
    const id = await makeJob({ status: "running", key });
    // 模拟 /api/plan 提交时已扣一次配额
    await consume(key, 3);
    expect(await peek(key, 3)).toBe(2);

    await interruptJob((await getStore().jobs.get(id))!);

    expect(await peek(key, 3)).toBe(3);
  });

  it("幂等：并发/重复自愈只退一次配额（不白送次数）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const key = `ip:stale-${Math.random().toString(36).slice(2)}`;
    const id = await makeJob({ status: "running", key });
    await consume(key, 3);
    const record = (await getStore().jobs.get(id))!;

    // 两个轮询请求几乎同时发现同一个僵尸任务
    await Promise.all([interruptJob(record), interruptJob(record)]);

    expect(await peek(key, 3)).toBe(3); // 只退一次（退两次会变成 4）
  });
});
