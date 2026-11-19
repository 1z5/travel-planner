// 「行中」能力的地基：给定行程起始日与今天，算出今天是行程第几天。
//
// 刻意做成 client-safe（不 import server-only）——PlanView 是客户端组件，
// 要用它给「今天」上徽章并自动滚动。日期合法性/时间解析/距离算术统一
// 从 lib/plan/time.ts 与 lib/geo/spatial.ts import（ADR-020 · R5：收敛前
// 本文件各有一份私有副本，现在只有一个来源）。
//
// 日期口径与 weather/ics 一致：字符串都按 UTC 午夜解析算差值，避免本地时区
// 把「差几天」算错。但「今天」这个日历日必须由调用方按**本地**时区给出——
// UTC+8 的清晨，toISOString() 会给成前一天（见 localTodayIso）。

import { isRealDate, parseTimeRangeTolerant } from "../plan/time";

/** UTC 午夜的毫秒数；非法日期返回 NaN */
function utcMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

export type TripToday =
  | { kind: "unknown" } // 没有/非法 startDate——不高亮，不猜
  | { kind: "before"; daysUntil: number } // 还没出发
  | { kind: "after" } // 已结束
  | { kind: "during"; dayIndex: number }; // 今天 = 行程第 dayIndex+1 天（0 基，索引进 plan.days）

/**
 * 算「今天」在行程里的位置。
 * @param startDate 行程首日 "YYYY-MM-DD"（缺失/非法 → unknown）
 * @param today     今天的日历日 "YYYY-MM-DD"（调用方按本地时区给出）
 * @param days      行程总天数（plan.days.length）
 */
export function tripToday(startDate: string | undefined, today: string, days: number): TripToday {
  if (
    !startDate ||
    !isRealDate(startDate) ||
    !isRealDate(today) ||
    !Number.isInteger(days) ||
    days < 1
  ) {
    return { kind: "unknown" };
  }
  const diff = Math.round((utcMs(today) - utcMs(startDate)) / 86400000);
  if (diff < 0) return { kind: "before", daysUntil: -diff };
  if (diff >= days) return { kind: "after" };
  return { kind: "during", dayIndex: diff };
}

/**
 * 本地时区的今天 "YYYY-MM-DD"。
 * 不能用 toISOString()——那是 UTC，China (UTC+8) 的清晨（0-8 点）会退回前一天。
 * 用本地 getFullYear/getMonth/getDate 才是用户眼里的「今天」。
 */
export function localTodayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 本地时间的分钟数（0-1439）——与 spot 的本地时间同口径 */
export function nowMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

function zonedClockFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function isTripTimeZone(timeZone: string): boolean {
  if (timeZone !== "UTC" && !timeZone.includes("/")) return false;
  try {
    zonedClockFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function tripClock(timeZone?: string, now = new Date()) {
  if (timeZone) {
    const parts = Object.fromEntries(
      zonedClockFormatter(timeZone)
        .formatToParts(now)
        .map(({ type, value }) => [type, value]),
    );
    return {
      todayIso: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }
  return { todayIso: localTodayIso(now), minutes: nowMinutes(now) };
}

export type SpotNow =
  | { kind: "now"; index: number } // 现在在进行第 index 个点
  | { kind: "next"; index: number } // 下一站是第 index 个点
  | { kind: "done" } // 今天的点都结束了
  | { kind: "none" }; // 没有可解析的时间（不猜）

/**
 * 算「现在」在进行哪个行程点 / 下一站是哪个。
 * @param spots  当天的行程点（读 time 字段）
 * @param nowMin 当前时间的分钟数（0-1439，调用方按本地时分给出）
 */
export function spotNow(spots: readonly { time: string }[], nowMin: number): SpotNow {
  const parsed: Array<{ i: number; r: { start: number; end: number } }> = [];
  spots.forEach((s, i) => {
    const r = parseTimeRangeTolerant(s.time);
    if (r) parsed.push({ i, r });
  });
  if (!parsed.length) return { kind: "none" };
  // 现在：now 落在 [start, end)
  const cur = parsed.find((x) => nowMin >= x.r.start && nowMin < x.r.end);
  if (cur) return { kind: "now", index: cur.i };
  // 下一站：start 严格大于 now 的最早一个
  let nextIdx = -1;
  let nextStart = Infinity;
  for (const x of parsed) {
    if (x.r.start > nowMin && x.r.start < nextStart) {
      nextStart = x.r.start;
      nextIdx = x.i;
    }
  }
  if (nextIdx >= 0) return { kind: "next", index: nextIdx };
  return { kind: "done" };
}
