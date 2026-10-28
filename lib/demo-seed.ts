import "server-only";
import { getStore } from "@/lib/store";
import { DEMO_FIXTURES } from "@/demo/fixtures";
import type { Plan, PlanInput } from "@/lib/types";

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
//
// 安全审计 R4：演示 token 是公开的（写在 DEMO.md 里），而「分享 token 即写能力」
// 意味着任何人都能改演示行程——可以把演示工件篡改成任意内容、甚至伪造修复链。
// 所以种子落库时给 plan 打 `demo: true` 标记，写端点（refine/restore/repair/
// adjust/候选替换）一律 403 只读；**克隆不受影响**（克隆产出的是新 Plan）。
// ============================================================

/** 写端点的统一判定：演示行程只读。返回 null = 可写；否则返回 403 文案。 */
export function demoWriteBlockedMessage(plan: Pick<Plan, "demo">): string | null {
  if (plan.demo !== true) return null;
  return "演示行程只读：这是公开的示例行程，不支持修改；可点「克隆成我的行程」生成一份属于你的行程后再编辑";
}

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
      // demo 标记必须在落库时写进 Plan（不是只在内存判断）：重启后种子会被
      // 跳过（已存在），标记若丢了，演示行程就又变成公开可写了。
      plan: { ...fixture.plan, demo: true },
      input,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    created += 1;
  }
  if (created > 0) {
    console.log(
      `[demo] 已注入 ${created}/${DEMO_FIXTURES.length} 条演示行程（share 链接可直接打开；标记 demo=只读）`,
    );
  }
  return created;
}
