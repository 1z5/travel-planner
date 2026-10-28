import { afterEach, describe, expect, it } from "vitest";
import { DEMO_FIXTURES } from "@/demo/fixtures";
import { demoWriteBlockedMessage, seedDemoPlans } from "@/lib/demo-seed";
import { getStore } from "@/lib/store";

// 安全审计 R4：演示 token 写在 DEMO.md 里是公开的，而「分享 token 即写能力」——
// 不打标记的话，任何人可 refine/restore/repair 演示行程。这里钉两条契约：
// 1) 种子落库必须带 plan.demo=true（重启后已存在的记录跳过注入，标记不能靠内存）；
// 2) 写端点统一用 demoWriteBlockedMessage 判断，文案可行动（提示去克隆）。

const originalDemoSeed = process.env.DEMO_SEED;

afterEach(() => {
  if (originalDemoSeed === undefined) delete process.env.DEMO_SEED;
  else process.env.DEMO_SEED = originalDemoSeed;
});

describe("demoWriteBlockedMessage", () => {
  it("demo=true → 明确「只读」并给出可行动出口（克隆）", () => {
    const msg = demoWriteBlockedMessage({ demo: true });
    expect(msg).toContain("只读");
    expect(msg).toContain("演示");
    expect(msg).toContain("克隆");
  });

  it("demo=false / 缺省 → 放行（普通行程可写）", () => {
    expect(demoWriteBlockedMessage({ demo: false })).toBeNull();
    expect(demoWriteBlockedMessage({})).toBeNull();
  });
});

describe("seedDemoPlans", () => {
  it("DEMO_SEED 非 1 → 不注入（生产/CI/e2e 无行为）", async () => {
    delete process.env.DEMO_SEED;
    expect(await seedDemoPlans()).toBe(0);
  });

  it("落库的演示行程带 plan.demo=true（重启后仍只读）", async () => {
    process.env.DEMO_SEED = "1";
    const created = await seedDemoPlans();
    expect(created).toBe(DEMO_FIXTURES.length);

    const store = getStore();
    for (const fixture of DEMO_FIXTURES) {
      const record = await store.plans.get(fixture.shareId);
      expect(record, `fixture ${fixture.shareId} 未写入`).not.toBeNull();
      expect(record?.plan.demo).toBe(true);
    }
  });

  it("已存在不覆盖（用户/演示期间改过的行程不会被重启冲掉）", async () => {
    process.env.DEMO_SEED = "1";
    // 上一条用例已注入；这里再跑一次应为 0
    expect(await seedDemoPlans()).toBe(0);
  });
});
