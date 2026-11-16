// ============================================================
// 时间/日期算术的唯一实现（client-safe 纯函数）。
//
// 【为什么有这一模块】（重构 ADR-020 · R5）
// 收敛前同一份算术散在五处：schedule.ts / replan.ts / replan 路由 /
// weather.ts 各写一份 parseClock 或 addDays，trip-day.ts、validate.ts、
// verify/engine.ts 各写一份 isRealDate——每份注释都写着「改的时候两处
// 一起改」。偏离检测（deviation.time_overrun）是事件驱动核心的算术，
// 多份实现漂移 = 检测器对不同端点说谎。收敛后：
//   - 判定口径只有一个来源；
//   - client-safe（不 import server-only），浏览器与 Node 跑同一份。
//
// 保留两种刻意的不同行为（都有单测钉住）：
// - parseTimeRange（严格）：跨零点/零长/「24:00」一律 null。顺延与求解
//   要拿上一个点的 end 当下一段起点，把「23:00-01:00」猜成「+24h 取模」
//   等于替用户假设了跨天停留，而行程点是「当天某段停留」；
// - parseTimeRangeTolerant（容错）：跨零点按零长处理。「现在在哪一站」
//   这类只读判定不能被脏数据挡死，但也不猜时长。
// ============================================================

/** "HH:mm-HH:mm" 的公共解析：只认格式与有限性，合法性口径由两个导出函数各自把关 */
function parseRangeParts(time: string): { sh: number; sm: number; eh: number; em: number } | null {
  const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return {
    sh: Number(m[1]),
    sm: Number(m[2]),
    eh: Number(m[3]),
    em: Number(m[4]),
  };
}

/**
 * 解析 spot.time（"HH:MM-HH:MM"）→ 当天的分钟数区间（严格口径）。
 *
 * @param time 形如 "09:00-11:30"；"9:30-11:00" 也接受
 * @returns { start, end }（均为当天分钟数）或 null（格式非法 / 越界 / 跨零点 / 零长）
 */
export function parseTimeRange(time: string): { start: number; end: number } | null {
  const p = parseRangeParts(time);
  if (!p) return null;
  // 分/时越界必须单独挡：「25:00」乘出来是 1500 分钟，靠 end<1440 判断
  // 碰巧能挡，但「24:00」算出来恰好 1440 会漏过去——它同样不是合法的时刻
  if (p.sm > 59 || p.em > 59 || p.sh > 23 || p.eh > 23) return null;
  const start = p.sh * 60 + p.sm;
  const end = p.eh * 60 + p.em;
  if (end <= start) return null; // 跨零点 / 零长
  return { start, end };
}

/**
 * 解析 spot.time（容错口径）：跨零点/零长按「零长区间」返回而不是 null。
 *
 * 给「现在在哪一站」这类只读判定用：数据脏（手改、旧版本）不该让整个
 * 行中视图失效，但也不能替用户猜一个时长——end 夹成 start 即「不知道
 * 多久，但它不挡路」。
 */
export function parseTimeRangeTolerant(time: string): { start: number; end: number } | null {
  const p = parseRangeParts(time);
  if (!p) return null;
  const start = p.sh * 60 + p.sm;
  const end = p.eh * 60 + p.em;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= 1440 || end < 0 || end >= 1440) return null;
  return { start, end: end > start ? end : start };
}

/** "HH:mm" → 当天分钟数；非法返回 null（活动时间格式不猜） */
export function parseClock(hhmm: string): number | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 分钟数 → "HH:MM"（补零；不取模——1440 渲染为 "24:00"，锚点跨零点的极端情况用） */
export function fmtHourMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 分钟数 → "HH:MM"（先取整再取模 1440）。
 * 给「建议几点出发」这类可能算出负数/超过一天的展示用：出发建议会把
 * 过去的时间夹到「现在」，取模保证任何输入都能渲染成合法时刻。
 */
export function fmtClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 合法日历日期：格式对 + 能 round-trip（挡掉 2026-02-30 / 2026-13-01 这类） */
export function isRealDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // 必须先挡 NaN：月越界给的是 Invalid Date，直接 toISOString() 会抛
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** "YYYY-MM-DD" + n 天 → "YYYY-MM-DD"（UTC 算术避免时区漂移；与 weather/ics 同口径） */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" 相差天数（to - from，UTC 算术避免时区漂移；非法返回 null） */
export function daysBetween(from: string, to: string): number | null {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}
