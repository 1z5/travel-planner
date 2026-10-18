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

/** 本地时间的分钟数（0-1439）——与 spot 的本地时间同口径 */
export function nowMinutes(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes();
}

/** 解析 "HH:mm-HH:mm" → { start, end }（分钟）；解析不了返回 null */
function parseRange(time: string): { start: number; end: number } | null {
  const m = time.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= 1440 || end < 0 || end >= 1440) return null;
  // 跨零点（如 23:00-01:00）：end<=start 时按零长处理——不参与「现在」判定，
  // 但其 start 仍参与「下一站」。记录为已知局限：行程里的点几乎都是白天时段。
  return { start, end: end > start ? end : start };
}

export type SpotNow =
  | { kind: "now"; index: number }    // 现在在进行第 index 个点
  | { kind: "next"; index: number }   // 下一站是第 index 个点
  | { kind: "done" }                  // 今天的点都结束了
  | { kind: "none" };                 // 没有可解析的时间（不猜）

/**
 * 算「现在」在进行哪个行程点 / 下一站是哪个。
 * @param spots  当天的行程点（读 time 字段）
 * @param nowMin 当前时间的分钟数（0-1439，调用方按本地时分给出）
 */
export function spotNow(
  spots: readonly { time: string }[],
  nowMin: number,
): SpotNow {
  const parsed: Array<{ i: number; r: { start: number; end: number } }> = [];
  spots.forEach((s, i) => {
    const r = parseRange(s.time);
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
