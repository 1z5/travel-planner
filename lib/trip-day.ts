// 「行中」能力的地基：给定行程起始日与今天，算出今天是行程第几天。
//
// 刻意做成 client-safe（不 import server-only）——PlanView 是客户端组件，
// 要用它给「今天」上徽章并自动滚动。日期合法性判断因此与 validate.ts 的
// isRealDate 重复（那边 server-only 不能复用）；4 行逻辑，复制比跨边界
// 导出更干净。
//
// 日期口径与 weather/ics 一致：字符串都按 UTC 午夜解析算差值，避免本地时区
// 把「差几天」算错。但「今天」这个日历日必须由调用方按**本地**时区给出——
// UTC+8 的清晨，toISOString() 会给成前一天（见 localTodayIso）。

/** UTC 午夜的毫秒数；非法日期返回 NaN */
function utcMs(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getTime();
}

/** 合法日历日期：格式对 + 能 round-trip（挡掉 2026-02-30 / 2026-13-01 这类） */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // 必须先挡 NaN：月越界给的是 Invalid Date，直接 toISOString 会抛
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

export type TripToday =
  | { kind: "unknown" }                    // 没有/非法 startDate——不高亮，不猜
  | { kind: "before"; daysUntil: number }  // 还没出发
  | { kind: "after" }                      // 已结束
  | { kind: "during"; dayIndex: number };  // 今天 = 行程第 dayIndex+1 天（0 基，索引进 plan.days）

/**
 * 算「今天」在行程里的位置。
 * @param startDate 行程首日 "YYYY-MM-DD"（缺失/非法 → unknown）
 * @param today     今天的日历日 "YYYY-MM-DD"（调用方按本地时区给出）
 * @param days      行程总天数（plan.days.length）
 */
export function tripToday(
  startDate: string | undefined,
  today: string,
  days: number,
): TripToday {
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
