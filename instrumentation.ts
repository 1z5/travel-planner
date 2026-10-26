/**
 * Next.js instrumentation 钩子：服务进程启动时执行一次。
 *
 * 目前只做一件事：DEMO_SEED=1 时把 demo/fixtures 里的真实生成行程灌进存储，
 * 让演示用的分享链接在冷启动/重启后依然秒开（见 lib/demo-seed.ts）。
 * 不设 DEMO_SEED 的环境（生产/CI/e2e）完全无行为。
 */
export async function register() {
  // instrumentation 在 edge 与 nodejs 两种 runtime 都可能加载；种子依赖存储
  // 实现（memory/postgres，均为 node-only），edge 下直接跳过。
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.DEMO_SEED !== "1") return;

  try {
    const { seedDemoPlans } = await import("@/lib/demo-seed");
    await seedDemoPlans();
  } catch (e) {
    // 种子失败不能阻止服务启动：演示环境宁可少几条样例，也不能起不来
    console.error(`[demo] 演示行程注入失败（服务继续启动）：${(e as Error).message}`);
  }
}
