import { describe, expect, it } from "vitest";
import { countdownFor } from "@/lib/countdown";

// 行前倒计时：全部基于 tripToday 口径，不自己另算日期；无法判断就不显示。

describe("countdownFor", () => {
  it("出发前 → 还有 N 天出发（1 天说「明天出发」）", () => {
    expect(countdownFor("2026-11-09", 3, "2026-10-28")).toEqual({
      text: "还有 12 天出发",
      tone: "soon",
    });
    expect(countdownFor("2026-11-09", 3, "2026-11-08")?.text).toBe("明天出发");
  });

  it("行程首日 → 今天出发", () => {
    expect(countdownFor("2026-11-09", 3, "2026-11-09")).toEqual({
      text: "今天出发",
      tone: "active",
    });
  });

  it("行程中 → 第 N 天", () => {
    expect(countdownFor("2026-11-09", 3, "2026-11-10")).toEqual({
      text: "行程第 2 天",
      tone: "active",
    });
  });

  it("行程已结束 → 提示已结束（不显示负天数）", () => {
    expect(countdownFor("2026-11-09", 3, "2026-11-20")).toEqual({
      text: "行程已结束",
      tone: "past",
    });
  });

  it("没有/非法日期 → null（不猜）", () => {
    expect(countdownFor(undefined, 3, "2026-11-09")).toBeNull();
    expect(countdownFor("2026-02-30", 3, "2026-11-09")).toBeNull();
  });
});
