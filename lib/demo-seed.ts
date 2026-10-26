import "server-only";
import { getStore } from "@/lib/store";
import { DEMO_FIXTURES } from "@/demo/fixtures";
import type { PlanInput } from "@/lib/types";

// ============================================================
// 演示种子：把「真实生成」的行程 fixture 灌进存储
//
// 为什么需要：面试/演示最怕现场等 3 分钟生成。把几条真实生成的行程
// （demo/fixtures/*.json，含真实 POI/营业时间/通勤）在服务启动时写进存储，
// 演示时 /p/<shareId> 秒开。
//
// 为什么不直接在启动时调 LLM 生成：冷启动会烧 token 且要等几分钟；
// fixture 是静态文件（随构建产物一起走），零成本、毫秒级、链接永久稳定
// ——连免费实例休眠杀进程后重启也还在。
//
// 只在 DEMO_SEED=1 时由 instrumentation.ts 调用。生产/测试都不设它 → 无行为。
// ============================================================

/** 注入演示行程；返回本次新写入的条数（已存在的不覆盖）。 */
export async function seedDemoPlans(): Promise<number> {
  if (process.env.DEMO_SEED !== "1") return 0;
  const store = getStore();
  let created = 0;
  for (const fixture of DEMO_FIXTURES) {
    // 跳过已存在：演示环境里用户改过（revision>1）的行程不该被重启覆盖
    const existing = await store.plans.get(fixture.shareId);
    if (existing) continue;
    const now = Date.now();
    // input 补 days：API 由起止日期推导天数，而 fixture 存的是提交给 API 的原始
    // 载荷（不含 days）。PlanRecord.input 是后续 refine/clone 的原料，缺 days 会
    // 让下游的「天数」校验判断成非法输入。
    const input: PlanInput = {
      ...fixture.input,
      days: fixture.plan.days.length,
    };
    await store.plans.save({
      id: fixture.shareId,
      plan: fixture.plan,
      input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  if (created > 0) {
    console.log(
      `[demo] 已注入 ${created}/${DEMO_FIXTURES.length} 条演示行程（share 链接可直接打开）`,
    );
  }
  return created;
}
