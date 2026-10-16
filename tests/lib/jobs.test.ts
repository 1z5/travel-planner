import { describe, expect, it } from "vitest";
import { dayFailureError } from "@/lib/jobs";

// dayFailureError 把「哪一天、哪个阶段、什么原因、已成功几天」组织成可行动的信息。
//
// 为什么用单测而不是 e2e：这三个阶段（生成/体检/进度保存）在 MOCK 模式下都
// 无法通过桩触发——DaySchema 会挡住畸形数据、内存 store 不会失败。e2e 只能
// 覆盖「生成」阶段（持续断流用例），另外两个阶段在这里补。

describe("dayFailureError", () => {
  it("生成阶段：完整信息（天/阶段/原因/进度）", () => {
    const e = dayFailureError(3, "生成", new Error("LLM 输出不是合法 JSON"), 2);
    expect(e.message).toBe(
      "第 4 天生成失败：LLM 输出不是合法 JSON（已成功生成 2 天，配额已退还，可重试）",
    );
    expect(e).toBeInstanceOf(Error);
  });

  it("体检阶段：不能再说成「生成失败」（否则用户会误以为重试有用）", () => {
    const e = dayFailureError(0, "体检", new Error("高德 QPS 超限"), 1);
    expect(e.message).toContain("第 1 天体检失败");
    expect(e.message).toContain("高德 QPS 超限");
    expect(e.message).not.toContain("生成失败");
  });

  it("进度保存阶段：区分落库失败与生成失败", () => {
    const e = dayFailureError(4, "进度保存", new Error("database is down"), 4);
    expect(e.message).toContain("第 5 天进度保存失败");
    expect(e.message).toContain("database is down");
    expect(e.message).toContain("已成功生成 4 天");
  });

  it("非 Error 抛出也有可读信息（不出现 undefined / [object Object]）", () => {
    const e = dayFailureError(1, "生成", "字符串错误", 0);
    expect(e.message).toContain("第 2 天生成失败：字符串错误");
    expect(e.message).not.toContain("undefined");
    expect(e.message).not.toContain("[object Object]");
  });

  it("一天都没成功时说清楚是 0 天（不隐瞒进度）", () => {
    const e = dayFailureError(0, "生成", new Error("boom"), 0);
    expect(e.message).toContain("已成功生成 0 天");
  });

  it("dayIdx 是 0 基下标，文案里要转成人类可读的第 N 天", () => {
    expect(dayFailureError(0, "生成", new Error("x"), 0).message).toContain("第 1 天");
    expect(dayFailureError(6, "生成", new Error("x"), 0).message).toContain("第 7 天");
  });
});
