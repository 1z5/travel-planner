import { describe, expect, it } from "vitest";
import { mapLimit, sleep } from "@/lib/concurrency";

describe("mapLimit", () => {
  it("结果按输入下标原序返回（乱序完成也不重排）", async () => {
    const out = await mapLimit([30, 10, 20], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("并发度受 limit 约束（同时在场数不超过 limit）", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
      return null;
    });
    expect(peak).toBe(3);
    expect(peak).toBeLessThan(8);
  });

  it("limit 大于任务数时按任务数开工", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapLimit([1, 2], 10, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight -= 1;
    });
    expect(peak).toBe(2);
  });

  it("空数组直接返回空结果", async () => {
    expect(await mapLimit([], 5, async () => 1)).toEqual([]);
  });

  it("单个任务抛错 → 原样抛出（不吞掉）", async () => {
    await expect(
      mapLimit([1, 2], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("失败后不再领新任务，且不产生未处理的 rejection", async () => {
    const started: number[] = [];
    const err = await mapLimit([1, 2, 3, 4], 2, async (n) => {
      started.push(n);
      await sleep(5);
      if (n === 1) throw new Error("first fails");
      return n;
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe("first fails");
    // 前两个并发启动，其中一个失败；不应再启动第 3、4 个
    expect(started.sort()).toEqual([1, 2]);
  });

  it("limit <= 0 时退化为串行而不是死锁", async () => {
    const out = await mapLimit([1, 2, 3], 0, async (n) => n);
    expect(out).toEqual([1, 2, 3]);
  });
});
