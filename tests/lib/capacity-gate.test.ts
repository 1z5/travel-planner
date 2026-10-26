import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capacityLimits,
  capacitySnapshot,
  releaseGenerationBudget,
  releaseLlmBudget,
  resetCapacityForTest,
  setCapacityDayForTest,
  tryAcquireSlot,
  tryReserveGenerationBudget,
  tryReserveLlmBudget,
} from "@/lib/capacity-gate";

// 全局限流/日预算闸门：审计 P0-3 的服务端兜底（配额按 IP 可伪造，只能防
// 「同一个用户多刷」；真实爆量需要进程内并发上限 + 日预算）。

const ENV_KEYS = [
  "MAX_CONCURRENT_GENERATIONS",
  "MAX_CONCURRENT_LLM",
  "DAILY_GLOBAL_LIMIT",
  "DAILY_GLOBAL_LLM_LIMIT",
];

function resetEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  resetEnv();
  resetCapacityForTest();
});

afterEach(() => {
  resetEnv();
  resetCapacityForTest();
});

describe("capacityLimits", () => {
  it("未配置时给安全默认值", () => {
    expect(capacityLimits()).toEqual({
      maxGenerations: 6,
      maxLlmCalls: 12,
      dailyGenerations: 500,
      dailyLlmCalls: 300,
    });
  });

  it("环境变量可覆盖；非法值回落默认（不能因为写错就变成 0 拒绝一切）", () => {
    process.env.MAX_CONCURRENT_GENERATIONS = "2";
    expect(capacityLimits().maxGenerations).toBe(2);
    for (const bad of ["0", "-3", "abc", "1.5"]) {
      process.env.MAX_CONCURRENT_GENERATIONS = bad;
      expect(capacityLimits().maxGenerations).toBe(6);
    }
  });
});

describe("并发槽", () => {
  it("达到上限后拒绝，释放后可再进", () => {
    process.env.MAX_CONCURRENT_GENERATIONS = "2";
    const a = tryAcquireSlot("generate");
    const b = tryAcquireSlot("generate");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(tryAcquireSlot("generate")).toBeNull();
    a!();
    expect(tryAcquireSlot("generate")).not.toBeNull();
  });

  it("释放幂等：重复调用不会把计数减成负数/放行超额请求", () => {
    process.env.MAX_CONCURRENT_GENERATIONS = "1";
    const release = tryAcquireSlot("generate")!;
    release();
    release();
    const again = tryAcquireSlot("generate");
    expect(again).not.toBeNull();
    again!();
    expect(tryAcquireSlot("generate")).not.toBeNull();
  });

  it("generate 与 llm 是两组独立额度（refine/chat 不挤占生成名额）", () => {
    process.env.MAX_CONCURRENT_GENERATIONS = "1";
    process.env.MAX_CONCURRENT_LLM = "1";
    const gen = tryAcquireSlot("generate");
    expect(gen).not.toBeNull();
    const llm = tryAcquireSlot("llm");
    expect(llm).not.toBeNull();
    expect(tryAcquireSlot("generate")).toBeNull();
    expect(tryAcquireSlot("llm")).toBeNull();
    gen!();
    llm!();
  });
});

describe("每日全站生成预算", () => {
  it("无上限配置时按默认值；显式上限用尽后拒绝，跨日归零", () => {
    process.env.DAILY_GLOBAL_LIMIT = "2";
    expect(tryReserveGenerationBudget()).toBe(true);
    expect(tryReserveGenerationBudget()).toBe(true);
    expect(tryReserveGenerationBudget()).toBe(false);
    // 伪造「昨天」，下一次读写应把日计数归零
    setCapacityDayForTest("1999-01-01");
    expect(tryReserveGenerationBudget()).toBe(true);
  });

  it("退还只用于「任务没建成」，不是失败重试绕过预算的通道", () => {
    process.env.DAILY_GLOBAL_LIMIT = "1";
    expect(tryReserveGenerationBudget()).toBe(true);
    expect(tryReserveGenerationBudget()).toBe(false);
    releaseGenerationBudget();
    expect(tryReserveGenerationBudget()).toBe(true);
  });

  it("快照含日计数、在跑数量与上限（健康检查用，不含用户数据）", () => {
    process.env.MAX_CONCURRENT_GENERATIONS = "3";
    process.env.DAILY_GLOBAL_LIMIT = "9";
    tryAcquireSlot("generate");
    tryReserveGenerationBudget();
    const snap = capacitySnapshot();
    expect(snap.active.generate).toBe(1);
    expect(snap.generationsToday).toBe(1);
    expect(snap.limits.maxGenerations).toBe(3);
    expect(snap.limits.dailyGenerations).toBe(9);
  });
});

describe("每日全站 LLM 调用预算", () => {
  it("refine/chat 不占生成配额，但受全站 LLM 日预算约束；用尽后拒绝、可退还", () => {
    process.env.DAILY_GLOBAL_LLM_LIMIT = "2";
    expect(tryReserveLlmBudget()).toBe(true);
    expect(tryReserveLlmBudget()).toBe(true);
    expect(tryReserveLlmBudget()).toBe(false);
    // 预扣后请求没走到 LLM（如行程刚好被删）→ 退还，不当成一次真实调用
    releaseLlmBudget();
    expect(tryReserveLlmBudget()).toBe(true);
  });

  it("跨 UTC 日归零：生成与 LLM 两个日计数都重置", () => {
    process.env.DAILY_GLOBAL_LLM_LIMIT = "1";
    expect(tryReserveLlmBudget()).toBe(true);
    expect(tryReserveLlmBudget()).toBe(false);
    setCapacityDayForTest("1999-01-01");
    expect(tryReserveLlmBudget()).toBe(true);
  });

  it("快照暴露两个日计数（健康检查/运维看得到）", () => {
    process.env.DAILY_GLOBAL_LLM_LIMIT = "9";
    tryReserveLlmBudget();
    const snap = capacitySnapshot();
    expect(snap.llmCallsToday).toBe(1);
    expect(snap.limits.dailyLlmCalls).toBe(9);
  });
});
