import { describe, expect, it } from "vitest";
import { localTodayIso, nowMinutes, spotNow, tripToday } from "@/lib/trip-day";

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

describe("spotNow 现在/下一站", () => {
  const s = (times: string[]) => times.map((time) => ({ time }));
  const DAY = ["08:00-10:00", "10:15-11:15", "11:30-12:50"];

  it("now 落在某点区间内 → now 该点", () => {
    expect(spotNow(s(DAY), 9 * 60)).toEqual({ kind: "now", index: 0 });       // 09:00
    expect(spotNow(s(DAY), 10 * 60 + 30)).toEqual({ kind: "now", index: 1 }); // 10:30
    expect(spotNow(s(DAY), 11 * 60 + 40)).toEqual({ kind: "now", index: 2 }); // 11:40
  });

  it("区间右端开边界：正好在某点结束时刻 → 不算该点 now，落到下一站", () => {
    expect(spotNow(s(DAY), 10 * 60)).toEqual({ kind: "next", index: 1 }); // 10:00 是第 0 点结束（开区间）
  });

  it("两站之间的空隙 → next 下一站", () => {
    expect(spotNow(s(DAY), 10 * 60 + 5)).toEqual({ kind: "next", index: 1 }); // 10:05
  });

  it("首站之前 → next 第一站", () => {
    expect(spotNow(s(DAY), 6 * 60 + 40)).toEqual({ kind: "next", index: 0 }); // 06:40
  });

  it("全部结束 → done", () => {
    expect(spotNow(s(DAY), 13 * 60)).toEqual({ kind: "done" }); // 13:00
  });

  it("无可解析时间 → none（不猜）", () => {
    expect(spotNow(s(["上午", "下午"]), 10 * 60)).toEqual({ kind: "none" });
    expect(spotNow([], 10 * 60)).toEqual({ kind: "none" });
  });

  it("混入不可解析的点：跳过它，其余照常判定", () => {
    const mixed = ["上午", "10:15-11:15"];
    expect(spotNow(s(mixed), 10 * 60 + 30)).toEqual({ kind: "now", index: 1 });
    expect(spotNow(s(mixed), 9 * 60)).toEqual({ kind: "next", index: 1 }); // 唯一可解析的点还没开始
  });

  it("跨零点时段按零长：不参与 now，仅参与 next（已知局限）", () => {
    const night = ["23:00-01:00"];
    expect(spotNow(s(night), 13 * 60)).toEqual({ kind: "next", index: 0 }); // 今晚 23 点那场是下一站
    expect(spotNow(s(night), 23 * 60 + 30)).toEqual({ kind: "done" });      // 23:30 已过 start，零长不算 now
  });

  it("乱序的时间也按 start 找最近的下一站", () => {
    const messy = ["15:30-16:30", "09:00-10:00"];
    expect(spotNow(s(messy), 8 * 60)).toEqual({ kind: "next", index: 1 }); // 最近的 start 是 09:00（index 1）
  });
});

describe("nowMinutes", () => {
  it("时分转分钟（0-1439）", () => {
    expect(nowMinutes(new Date(2026, 0, 1, 9, 30))).toBe(570);
    expect(nowMinutes(new Date(2026, 0, 1, 0, 0))).toBe(0);
    expect(nowMinutes(new Date(2026, 0, 1, 23, 59))).toBe(1439);
  });
});
