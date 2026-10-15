// 通用异步工具：有界并发 + 休眠。
// 不 import "server-only"——这样 Vitest 也能直接单测它。

/**
 * 有界并发 map：最多 `limit` 个任务同时在飞，结果按下标原序返回。
 *
 * 为什么需要：高德 POI 验真/通勤估算都是独立的 HTTP 调用，串行会让一次
 * 体检多等十几秒；但个人 key 有 QPS 限制，全量并发又会被打满。用固定
 * 并发度（见调用方 VERIFY_CONCURRENCY）兼顾速度与配额安全。
 *
 * 失败语义：任一任务抛错时，不再启动新任务，等所有在飞任务落定后抛出
 * 第一个错误（避免 Promise.all 早退后其他 rejection 变成 unhandled）。
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) return results;

  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  // 用对象承载失败态：直接 let 变量在闭包里赋值后，TS 在外层会把它收窄成
  // never（控制流分析不跨函数边界），导致 throw 处报类型错误
  const state: { failure?: { error: unknown } } = {};

  const worker = async () => {
    while (next < items.length) {
      if (state.failure) return; // 已有失败：不再领新任务
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        if (!state.failure) state.failure = { error: e };
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
  if (state.failure) throw state.failure.error;
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
