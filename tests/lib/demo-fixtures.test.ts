import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_FIXTURES } from "@/demo/fixtures";
import { seedDemoPlans } from "@/lib/demo-seed";
import { getStore } from "@/lib/store";

// 面试演示的预置行程：fixture 是「真实高德 + 真实模型」的生成产物，被静态打进
// 构建产物、启动时注入存储。这里守住三件事：
// 1) fixture 本身结构合法（坏 JSON 会让 /p 页 500，演示当场翻车）；
// 2) shareId 不可重复（重复会互相覆盖）；
// 3) 种子逻辑幂等、且只在 DEMO_SEED=1 时生效（不能影响生产/测试）。

describe("demo fixtures", () => {
  it("至少 2 条预置行程（真实生成产物，面试免等待）", () => {
    expect(DEMO_FIXTURES.length).toBeGreaterThanOrEqual(2);
  });

  it("shareId 唯一且是 URL-safe token", () => {
    const ids = DEMO_FIXTURES.map((f) => f.shareId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
  });

  it("每条行程：城市/日期/天数连续/每天有点位", () => {
    for (const f of DEMO_FIXTURES) {
      expect(f.plan.city.length).toBeGreaterThan(0);
      expect(f.plan.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.plan.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(f.plan.days.length).toBeGreaterThanOrEqual(1);
      // 天编号必须连续 1..N：演示页直接按 day 渲染，跳号会显示错乱
      expect(f.plan.days.map((d) => d.day)).toEqual(f.plan.days.map((_, i) => i + 1));
      for (const day of f.plan.days) {
        expect(day.spots.length).toBeGreaterThanOrEqual(1);
        for (const spot of day.spots) {
          expect(spot.name.length).toBeGreaterThan(0);
          expect(spot.time).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
        }
      }
      expect(f.plan.days.length).toBe(f.input.days ?? f.plan.days.length);
    }
  });
});

describe("seedDemoPlans", () => {
  beforeEach(() => {
    delete process.env.DEMO_SEED;
  });

  it("未设 DEMO_SEED=1 时不做任何事（生产/CI 无副作用）", async () => {
    expect(await seedDemoPlans()).toBe(0);
  });

  it("DEMO_SEED=1：注入全部 fixture，重复调用幂等（不覆盖已有行程）", async () => {
    process.env.DEMO_SEED = "1";
    const created = await seedDemoPlans();
    expect(created).toBe(DEMO_FIXTURES.length);

    const store = getStore();
    const first = DEMO_FIXTURES[0]!;
    const record = await store.plans.get(first.shareId);
    expect(record).not.toBeNull();
    expect(record?.plan.city).toBe(first.plan.city);
    // input.days 由种子逻辑补全（fixture 存的是提交给 API 的原始载荷，不含 days）
    expect(record?.input.days).toBe(first.plan.days.length);
    expect(record?.input.city).toBe(first.input.city);

    // 二次调用：已存在 → 0 条，且不应把 revision 重置回 1（不覆盖演示中改过的行程）
    expect(await seedDemoPlans()).toBe(0);
    const again = await store.plans.get(first.shareId);
    expect(again?.revision).toBe(record?.revision);
  });
});
