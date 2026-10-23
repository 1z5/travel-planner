import { describe, expect, it } from "vitest";
import { baseLines } from "@/lib/planner";
import { finalizePlan } from "@/lib/validate";
import type { PlanInput } from "@/lib/types";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 穷游模式契约：预算 0 / 极低预算是**正当输入**，不是要拒绝的异常。
// 这条契约曾经是反的（min(500) + 「总花费应落在 80%-100% 预算之间」），
// 把「周末进城逛免费博物馆」的用户直接挡在门外。

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "成都",
    budget: 3000,
    days: 3,
    startAt: "2026-11-01T10:00",
    endAt: "2026-11-03T18:00",
    pace: "balanced",
    scope: "city",
    preferences: ["美食"],
    ...over,
  } as PlanInput;
}

describe("穷游模式：预算约束口径", () => {
  it("预算 0：给「优先免费低价、不凑数」，不给「应落在 1-0 元之间」的矛盾指令", () => {
    const lines = baseLines(input({ budget: 0 })).join("\n");
    expect(lines).toContain("穷游/低预算模式");
    expect(lines).toContain("优先免费与低价项目");
    expect(lines).not.toContain("应落在 1-0 元之间");
    // 矛盾指令（区间上界小于下界）与「逼用户花钱」的口径都不能出现
    expect(lines).not.toMatch(/应落在 \d+-\d+ 元之间/);
    expect(lines).not.toContain("不要大幅低于预算");
  });

  it("日均不足 100 元同样算穷游（3 天 <300）", () => {
    const lines = baseLines(input({ budget: 200 })).join("\n");
    expect(lines).toContain("穷游/低预算模式");
  });

  it("正常预算：仍是「贴近预算」的区间约束（不因穷游分支变松）", () => {
    const lines = baseLines(input({ budget: 3000 })).join("\n");
    expect(lines).toContain("全程人均总花费应落在 2400-3000 元之间");
    expect(lines).not.toContain("穷游/低预算模式");
  });
});

describe("穷游模式：体检不误报", () => {
  // 直接走 finalizePlan（预算核对的所在处），不拉起高德桩——本条只测预算口径
  const ctx = (grandTotal: number) => ({
    warnings: [] as string[],
    unverified: [] as string[],
    transitUnknownDays: [] as number[],
    grandTotal,
    missCount: 0,
    poiTotal: 0,
  });

  it("预算 0 且有花费：不报「超支」（也不会出现 Infinity%）", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.budgetCny = 0;
    finalizePlan(plan, input({ budget: 0 }), ctx(1925));
    const budgetWarnings = (plan.warnings ?? []).filter((w) => /超支|超出预算|预算宽松/.test(w));
    expect(budgetWarnings).toHaveLength(0);
    expect(JSON.stringify(plan.warnings ?? [])).not.toContain("Infinity");
  });

  it("预算 0 且全免费：不出「预算宽松」这类反向噪音", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.budgetCny = 0;
    finalizePlan(plan, input({ budget: 0 }), ctx(0));
    expect((plan.warnings ?? []).filter((w) => w.includes("预算"))).toHaveLength(0);
  });

  it("正常预算仍会报超支（穷游分支没有把预警一起关掉）", () => {
    const plan = structuredClone(SAMPLE_PLAN);
    plan.budgetCny = 1000;
    finalizePlan(plan, input({ budget: 1000 }), ctx(1925));
    expect((plan.warnings ?? []).some((w) => w.includes("超出预算"))).toBe(true);
  });
});
