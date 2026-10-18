import { describe, expect, it } from "vitest";
import { localTodayIso, tripToday } from "@/lib/trip-day";

// tripToday 是「行中」高亮的地基：算错一天，用户打开 App 就看到错的「今天」。
// 边界（出发前/最后一天/结束后/缺日期）必须钉死。

describe("tripToday", () => {
  const DAYS = 3;
  const START = "2026-10-18";

  it("没有 startDate → unknown（不猜日期，与天气/活动同一立场）", () => {
    expect(tripToday(undefined, "2026-10-18", DAYS)).toEqual({ kind: "unknown" });
  });

  it("startDate 非法 → unknown（格式对但日历不存在也不能用）", () => {
    expect(tripToday("2026-02-30", "2026-10-18", DAYS)).toEqual({ kind: "unknown" });
    expect(tripToday("2026-13-01", "2026-10-18", DAYS)).toEqual({ kind: "unknown" });
    expect(tripToday("10月18日", "2026-10-18", DAYS)).toEqual({ kind: "unknown" });
    expect(tripToday("2026-1-1", "2026-10-18", DAYS)).toEqual({ kind: "unknown" });
  });

  it("today 非法或 days 非正 → unknown", () => {
    expect(tripToday(START, "not-a-date", DAYS)).toEqual({ kind: "unknown" });
    expect(tripToday(START, "2026-10-18", 0)).toEqual({ kind: "unknown" });
    expect(tripToday(START, "2026-10-18", -1)).toEqual({ kind: "unknown" });
  });

  it("出发前 → before，daysUntil 是距出发还有几天", () => {
    expect(tripToday(START, "2026-10-15", DAYS)).toEqual({ kind: "before", daysUntil: 3 });
    expect(tripToday(START, "2026-10-17", DAYS)).toEqual({ kind: "before", daysUntil: 1 });
  });

  it("出发当天 → during 第 0 天", () => {
    expect(tripToday(START, "2026-10-18", DAYS)).toEqual({ kind: "during", dayIndex: 0 });
  });

  it("行程中 → during 对应 0 基索引", () => {
    expect(tripToday(START, "2026-10-19", DAYS)).toEqual({ kind: "during", dayIndex: 1 });
    expect(tripToday(START, "2026-10-20", DAYS)).toEqual({ kind: "during", dayIndex: 2 });
  });

  it("最后一天仍是 during（startDate + days - 1）", () => {
    // 3 天行程：18/19/20 在行程内，20 是最后一天
    expect(tripToday(START, "2026-10-20", DAYS)).toEqual({ kind: "during", dayIndex: 2 });
  });

  it("结束次日 → after（startDate + days）", () => {
    expect(tripToday(START, "2026-10-21", DAYS)).toEqual({ kind: "after" });
    expect(tripToday(START, "2026-11-01", DAYS)).toEqual({ kind: "after" });
  });

  it("跨月/跨年边界正确", () => {
    // 12/30 起 3 天：12/30、12/31、1/1
    expect(tripToday("2026-12-30", "2026-12-31", 3)).toEqual({ kind: "during", dayIndex: 1 });
    expect(tripToday("2026-12-30", "2027-01-01", 3)).toEqual({ kind: "during", dayIndex: 2 });
    expect(tripToday("2026-12-30", "2027-01-02", 3)).toEqual({ kind: "after" });
    expect(tripToday("2026-12-30", "2026-12-29", 3)).toEqual({ kind: "before", daysUntil: 1 });
  });

  it("闰日边界正确（2024 是闰年）", () => {
    expect(tripToday("2024-02-28", "2024-02-29", 2)).toEqual({ kind: "during", dayIndex: 1 });
    expect(tripToday("2024-02-28", "2024-03-01", 2)).toEqual({ kind: "after" });
  });

  it("单日行程：出发当天 during，次日 after", () => {
    expect(tripToday(START, START, 1)).toEqual({ kind: "during", dayIndex: 0 });
    expect(tripToday(START, "2026-10-19", 1)).toEqual({ kind: "after" });
  });
});

describe("localTodayIso", () => {
  it("格式化为 YYYY-MM-DD（月日补零）", () => {
    expect(localTodayIso(new Date(2026, 0, 5))).toBe("2026-01-05"); // 1 月 5 日
    expect(localTodayIso(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("用本地时区的年月日（不受 UTC 偏移影响）", () => {
    // 关键：UTC+8 的清晨若用 toISOString 会退回前一天，这里必须给本地日
    const d = new Date(2026, 9, 18, 1, 30); // 本地 10/18 凌晨 1:30
    expect(localTodayIso(d)).toBe("2026-10-18");
  });
});
