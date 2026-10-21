// 「到得了、进得去」的判定原语：把高德营业时间原文（open_time / opentime2）
// 解析成可判定的结构，再回答「这个到达时间开不开门 / 这次停留会不会被关门截断」。
//
// 为什么是 client-safe 纯函数：PlanView / TodayView 之后也要展示「周几开、几点
// 关门」，所以这里不 import "server-only"、不发任何网络请求——输入只有文本 + 日期
// + 分钟数，结果可单测、可在浏览器跑。
//
// 产品红线「不猜、不假装」的落地方式（也是本文件的契约）：
// - 解析不确定 / 数据不足 → unknown，调用方据此**不展示、不告警**，而不是猜一个结论；
// - 高德原文里的例外（法定节假日、年份限定、另行公告）能识别就降级成
//   「节假日以官方公告为准」提示，不假装自己知道节假日安排；
// - 同一分句里出现无法可靠归属的营业/闭馆信息、或同一天多组规则互相矛盾时，
//   宁可整条 unknown，也不挑一个「看起来合理」的答案。
//
// 真机格式（2026-10 用真实高德 key + extensions=all 实测，见 scripts/amap-stub.mjs
// 的确定性桩与 tests/lib/poi-hours.test.ts 的原文样本）：
//   周一至周日 08:00-17:15
//   1月至2月,11月至12月 周一至周日 07:30-17:00 最晚进入16:30；3月至10月 …
//   09/25-09/27 10:00–20:00开放 最晚进入19:00；01/01-09/24 周二–周日 …
//   08:00-17:00，16:30停止售检票；2月15日-2月23日:08:00-17:30，17:00停止售检票
//   周一至周五 10:30-13:30,16:30-21:00
//   24小时营业 / 周一至周日 00:00-24:00
// 高德字段本身可能是字符串或数组（`[]` = 没数据），入口先统一归一化。

import type { SpotPoiMeta } from "./types";

/** 营业时间判定结果：open=到达/离开都在营业时段内；closed=当天闭馆；
 *  outside=到达或离开落在营业时段外（reason 写清差在哪）；unknown=数据不足/无法可靠解析。 */
export type HoursCheck =
  | { state: "open" }
  | { state: "closed"; reason: string }
  | { state: "outside"; reason: string }
  | { state: "unknown" };

/** checkOpenHours 的输入：PlanSpot.poi 的子集（多给字段无妨） */
export interface HoursPoiInput {
  openTime?: string;
  openTime2?: string;
  name?: string;
  temporarilyClosed?: boolean;
}

// ---------- 内部结构 ----------

/** 分钟数区间 [start, end)；end 最大 1440（24:00）。跨零点营业时间不支持（见窗口校验）。 */
interface MinutesWindow {
  start: number;
  end: number;
}

/** 自然日区间（MMDD 编码，如 03-16 → 316）。from > to 表示跨年（11-01 至 03-15）。 */
interface MonthDayRange {
  from: number;
  to: number;
}

/** 月份区间（1-12）。from > to 表示跨年（11月 至 2月）。 */
interface MonthRange {
  from: number;
  to: number;
}

type RuleKind = "windows" | "closed" | "note";

interface HoursRule {
  raw: string;
  kind: RuleKind;
  windows: MinutesWindow[];
  /** 最后入场时刻（分钟）。高德把「最晚进入 / 停止售票/入馆/售检票」都归入此语义。 */
  lastEntry: number | null;
  /** 星期限定（1=周一 … 7=周日）；null = 原文没限定（每天都开） */
  weekdays: Set<number> | null;
  dateRanges: MonthDayRange[];
  monthRanges: MonthRange[];
  /** 原文含法定节假日/春节等例外 → 判定仍按周规则，但 reason 要提示以官方公告为准 */
  holidayCaveat: boolean;
}

interface ParsedSchedule {
  rules: HoursRule[];
  caveat: boolean;
}

interface DateCtx {
  weekday: number; // 1..7
  month: number; // 1..12
  md: number; // MMDD
}

// ---------- 常量 ----------

const WEEK_CHARS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
};
const WEEK_LABEL = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
/** formatHoursShort 的输出上限：UI 展示用，太长就不显示（宁可没有也不能挤爆卡片） */
const SHORT_MAX_CHARS = 48;
/** 闭馆 reason 里引用原文时的截断长度 */
const RAW_REASON_MAX = 36;

// 时间窗口：HH:MM-HH:MM（冒号全/半角，连接符覆盖 - — – ~ ～ 至 到）。
// 必须带冒号，避免和日期段（MM-DD、MM/DD、M月D日）混淆。
const WINDOW_RE = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-—–~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/g;
const WINDOW_AT_RE = /(\d{1,2})\s*[:：]\s*(\d{2})\s*[-—–~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/;
const ALL_DAY_RE = /24\s*小时(?:营业|开放)?|全天(?:开放|营业)|全天候/;

// 日期段（按「分句前缀」语义）：支持 MM/DD-MM/DD、M月D日-M月D日、MM-DD至MM-DD。
// 中文日期段的结束日允许省略「月」（如「5月1日至5日」，实测出现在节假日说明里），
// 但那类分句通常带年份限定、会被当作说明忽略，这里不专门解析。
const DATE_RANGE_RES: RegExp[] = [
  /(\d{1,2})\/(\d{1,2})\s*[-—–~～至到]\s*(\d{1,2})\/(\d{1,2})/g,
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*[-—–~～至到]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g,
  /(\d{1,2})-(\d{1,2})\s*至\s*(\d{1,2})-(\d{1,2})/g,
];
const MONTH_RANGE_RE = /(\d{1,2})\s*月\s*(?:至|到|[-—–~～])\s*(\d{1,2})\s*月/g;

// 星期：区间（周一至周五 / 周二–周日）+ 单点（每周一、周一,周日）。缩写与顿号/逗号天然被单点正则覆盖。
const WEEK_RANGE_RE =
  /(?:周|星期|礼拜)\s*([一二三四五六日天])\s*(?:至|到|[-—–~～])\s*(?:周|星期|礼拜)?\s*([一二三四五六日天])/g;
const WEEK_SINGLE_RE = /(?:周|星期|礼拜)\s*([一二三四五六日天])/g;

// 最后入场：两种真实写法——「最晚进入16:30」与「17:00停止售票(停止入馆)」「16:30停止售检票」。
const LAST_ENTRY_RES: RegExp[] = [
  /(?:最晚进入|最晚入园|最晚入馆|最晚入场|最后入场|最后进入)\s*[:：]?\s*(\d{1,2})\s*[:：]\s*(\d{2})/g,
  /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:停止售检票|停止售票|停止检票|停止入馆|停止入园|停止入场)/g,
];

// 闭馆类关键词。刻意**不含**「闭园」：同里古镇原文「17:15后各子景点闭园，街道免费开放」
// 说的是子景点闭园、点位仍可逛，算作闭馆会误报整点关闭（实测样本）。
const CLOSED_RE = /闭馆|休馆|不开放|不营业|停业|休息日/;
// 带「条件/例外」意味的词：这类分句在没有星期/日期限定时不能当确定性闭馆规则。
const CONDITIONAL_RE = /另行|届时|如遇|如有|若遇|临时|公告|为准|视情况|天气|维修|活动/;
const HOLIDAY_RE = /法定节假日|节假日|法定假日|春节|元旦|劳动节|国庆|端午|中秋|清明|假期|假日/;
/** 原文含具体年份 → 是「某年某假期」的历史/一次性规则，无法对任意日期求值，只能忽略+提示 */
const YEAR_RE = /(?:19|20)\d{2}\s*年/;

/**
 * 把高德字段归一化成文本：真实返回里同一字段可能是字符串、数组（`[]`/多段数组）。
 * 数组用中文分号拼回——后续解析器按分句处理，语义不丢。
 */
function asText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const t = value.trim();
    return t || undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter(Boolean);
    return parts.length ? parts.join("；") : undefined;
  }
  return undefined;
}

/** 分钟数 → "HH:MM"（1440 → "24:00"） */
function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 把 HH 与 MM 字符串转分钟；isEnd 时允许 24:00 = 1440 */
function toMinutes(hourText: string, minuteText: string, isEnd: boolean): number | null {
  const h = Number(hourText);
  const m = Number(minuteText);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  if (m < 0 || m > 59) return null;
  if (isEnd && h === 24 && m === 0) return 1440;
  if (h < 0 || h > 23) return null;
  return h * 60 + m;
}

// ---------- 分句 ----------

/**
 * 按高德原文的分句切分。分隔符：；;。换行。
 *
 * 额外处理（实测样本）：高德偶尔把两条独立规则直接拼在一个分句里、没有分号——
 * 石家饭店 `周六至周日 00:00-24:00 10-01至10-07 周一至周日 10:30-13:30,…`。
 * 在「空白 + 日期段」处再切一刀，否则两条规则会被误读成同一条（窗口叠加/限定混淆）。
 *
 * 注意**不**按逗号切：`9:00-18:00,17:00停止售票`、`1月至2月,11月至12月`、
 * `周一至周五 10:30-13:30,16:30-21:00` 里的逗号都是同一条规则内部的枚举。
 */
const DATE_SPLIT_RE =
  /[ \u3000\u00a0]+(?=(?:\d{1,2}\s*月\s*\d{1,2}\s*日?\s*[-—–~～至到]\s*\d{1,2}\s*月)|\d{1,2}\/\d{1,2}\s*[-—–~～至到]\s*\d{1,2}\/\d{1,2}|\d{1,2}-\d{1,2}\s*至\s*\d{1,2}-\d{1,2})/;

function splitClauses(text: string): string[] {
  const out: string[] = [];
  for (const line of text.replace(/\r/g, "").split(/[；;。\n]/)) {
    for (const part of line.split(DATE_SPLIT_RE)) {
      const t = part.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

// ---------- 分句解析 ----------

function parseWeekdays(text: string): Set<number> | null {
  const days = new Set<number>();
  const consumed: Array<[number, number]> = [];

  for (const m of text.matchAll(WEEK_RANGE_RE)) {
    const a = WEEK_CHARS[m[1]];
    const b = WEEK_CHARS[m[2]];
    if (!a || !b) continue;
    // 沿 1..7 环形展开；a===b 时只落一天（guard 防死循环）
    let d = a;
    for (let guard = 0; guard < 7; guard++) {
      days.add(d);
      if (d === b) break;
      d = d === 7 ? 1 : d + 1;
    }
    consumed.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }

  for (const m of text.matchAll(WEEK_SINGLE_RE)) {
    const idx = m.index ?? 0;
    // 已作为区间消费掉的（如「周一至周五」里的周一/周五）不重复解析；
    // 重复解析本身无害，但会让「被消费」逻辑不可靠，故显式跳过。
    if (consumed.some(([s, e]) => idx >= s && idx < e)) continue;
    const d = WEEK_CHARS[m[1]];
    if (d) days.add(d);
  }

  if (days.size) return days;
  // 「每天 / 每日」= 一周七天全开
  if (/每天|每日|天天/.test(text)) return new Set([1, 2, 3, 4, 5, 6, 7]);
  return null;
}

/** MMDD 编码；非法月/日返回 null */
function toMonthDay(month: number, day: number): number | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return month * 100 + day;
}

function parseDateRanges(text: string): MonthDayRange[] {
  const out: MonthDayRange[] = [];
  for (const re of DATE_RANGE_RES) {
    for (const m of text.matchAll(re)) {
      const from = toMonthDay(Number(m[1]), Number(m[2]));
      const to = toMonthDay(Number(m[3]), Number(m[4]));
      if (from === null || to === null) continue;
      out.push({ from, to });
    }
  }
  return out;
}

function parseMonthRanges(text: string): MonthRange[] {
  const out: MonthRange[] = [];
  for (const m of text.matchAll(MONTH_RANGE_RE)) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
    if (from < 1 || from > 12 || to < 1 || to > 12) continue;
    out.push({ from, to });
  }
  return out;
}

/** 同一分句里多个「最后入场」时刻且不一致 → 无法归属到窗口，视为解析失败 */
function parseLastEntry(text: string): { value: number | null; ambiguous: boolean } {
  const values: number[] = [];
  for (const re of LAST_ENTRY_RES) {
    for (const m of text.matchAll(re)) {
      const v = toMinutes(m[1], m[2], false);
      if (v !== null) values.push(v);
    }
  }
  const unique = [...new Set(values)];
  if (unique.length > 1) return { value: null, ambiguous: true };
  return { value: unique.length === 1 ? unique[0] : null, ambiguous: false };
}

function makeNoteRule(raw: string, holidayCaveat: boolean): HoursRule {
  return {
    raw,
    kind: "note",
    windows: [],
    lastEntry: null,
    weekdays: null,
    dateRanges: [],
    monthRanges: [],
    holidayCaveat,
  };
}

/**
 * 解析单个分句。返回 null = 这一分句**无法可靠解析**（调用方应把整条 POI 降级
 * unknown，不能跳过它继续判——因为被跳过的可能正是今天的闭馆规则）。
 *
 * 分类规则：
 * 1. 有营业窗口 → windows 规则（除非窗口其实是「春节 09:00-17:00」这类带节假日
 *    限定的特殊规则：无法对任意日期求值，降级为说明）；
 * 2. 无窗口 + 闭馆关键词 + 有星期/日期限定 → closed 规则；
 * 3. 其余（纯说明、年份限定、临时闭馆声明）→ note 规则（不参与判定，可能带来
 *    节假日提示）。
 */
function parseClause(raw: string): HoursRule | null {
  const holiday = HOLIDAY_RE.test(raw);
  const holidayIdx = raw.search(HOLIDAY_RE);

  // 营业窗口
  const windows: MinutesWindow[] = [];
  let invalidTime = false;
  for (const m of raw.matchAll(WINDOW_RE)) {
    const start = toMinutes(m[1], m[2], false);
    const end = toMinutes(m[3], m[4], true);
    // 跨零点营业（如 17:00-02:00）当前不支持：end<=start 直接判解析失败（unknown），
    // 而不是把 02:00 当成当天凌晨去算出一个看似合理的错误结论。
    if (start === null || end === null || start >= end) {
      invalidTime = true;
      continue;
    }
    windows.push({ start, end });
  }
  const hasExplicitWindow = windows.length > 0;
  if (!hasExplicitWindow && ALL_DAY_RE.test(raw)) windows.push({ start: 0, end: 1440 });
  if (invalidTime) return null;

  const { value: lastEntry, ambiguous: lastEntryAmbiguous } = parseLastEntry(raw);
  if (lastEntryAmbiguous) return null;

  const weekdays = parseWeekdays(raw);
  const dateRanges = parseDateRanges(raw);
  const monthRanges = parseMonthRanges(raw);
  const dayScoped = weekdays !== null && weekdays.size < 7;
  const hasScope = dayScoped || dateRanges.length > 0 || monthRanges.length > 0;
  const firstWindowIdx = raw.search(WINDOW_AT_RE);
  // 节假日词出现在第一个窗口**之前** = 它是窗口的限定语（「春节 09:00-17:00」），
  // 无法对任意日期求值 → 说明；出现在窗口之后（括号补充）→ 窗口规则 + caveat。
  const holidayQualifier = holiday && holidayIdx >= 0 && holidayIdx < firstWindowIdx;

  // 年份限定（如「2025年五一假期…」）：历史/一次性规则，无法套到任意日期。
  // 忽略但保留提示；若整条文本只有这类规则，上层会因没有可用规则而 unknown。
  if (YEAR_RE.test(raw)) return makeNoteRule(raw, holiday);

  if (windows.length) {
    // 同一条分句既给营业窗口又给闭馆词：语义冲突（哪个窗口被闭馆覆盖？），
    // 不猜，整条 unknown。
    if (CLOSED_RE.test(raw)) return null;
    if (holidayQualifier) return makeNoteRule(raw, holiday);
    // 无任何星期/日期限定的多窗口：可能是「午休两段」（应取并集），也可能是
    // 高德把两个季节的营业时间直接拼在一起（取并集会把冬天多算一小时）。
    // 两种语义无法区分——若窗口重叠，整条 unknown；若完全不相交，按午休两段取并集。
    if (!hasScope && windows.length > 1 && hasOverlappingWindows(windows)) return null;
    return {
      raw,
      kind: "windows",
      windows,
      lastEntry,
      weekdays,
      dateRanges,
      monthRanges,
      holidayCaveat: holiday,
    };
  }

  if (CLOSED_RE.test(raw)) {
    // 闭馆必须能确定「哪几天」：星期或日期段限定。
    // 无任何限定的「全天不开放」无法对任意日期求值 → unknown；
    // 但带条件词/节假日词的「如遇维修临时闭馆」是说明，不是每日规则 → note。
    if (hasScope) {
      return {
        raw,
        kind: "closed",
        windows: [],
        lastEntry: null,
        weekdays,
        dateRanges,
        monthRanges,
        holidayCaveat: holiday,
      };
    }
    if (CONDITIONAL_RE.test(raw) || holiday) return makeNoteRule(raw, holiday);
    return null;
  }

  // 无窗口、无闭馆词：纯说明（「夜间开放时间另行公布」「游船每天两班…」）。
  return makeNoteRule(raw, holiday);
}

function hasOverlappingWindows(windows: MinutesWindow[]): boolean {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) return true;
  }
  return false;
}

/** 解析整条营业时间文本；任一可识别分句失败 → null（整条 unknown，绝不半信半疑） */
function parseSchedule(text: string): ParsedSchedule | null {
  const clauses = splitClauses(text);
  if (!clauses.length) return null;
  const rules: HoursRule[] = [];
  let caveat = false;
  for (const clause of clauses) {
    const rule = parseClause(clause);
    if (rule === null) return null;
    if (rule.holidayCaveat) caveat = true;
    rules.push(rule);
  }
  // 只有说明、没有一条可判定的营业/闭馆规则 → 数据不足以回答
  if (!rules.some((r) => r.kind !== "note")) return null;
  return { rules, caveat };
}

// ---------- 判定 ----------

function parseIsoDate(isoDate: string): DateCtx | null {
  if (typeof isoDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const d = new Date(`${isoDate}T00:00:00Z`);
  // 非法日期（2026-13-01 / 2026-02-30）要先挡 NaN，否则 toISOString 会抛 RangeError。
  // round-trip 对不上说明被 Date 静默滚动过（2026-02-30 → 03-02），同样判非法。
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== isoDate) return null;
  const jsDay = d.getUTCDay(); // 0=周日
  return {
    weekday: jsDay === 0 ? 7 : jsDay,
    month: d.getUTCMonth() + 1,
    md: (d.getUTCMonth() + 1) * 100 + d.getUTCDate(),
  };
}

function inMonthDayRange(md: number, range: MonthDayRange): boolean {
  // from > to 即跨年（11-01 至 03-15）：命中的是「年末或年初」两段
  return range.from <= range.to
    ? md >= range.from && md <= range.to
    : md >= range.from || md <= range.to;
}

function inMonthRange(month: number, range: MonthRange): boolean {
  return range.from <= range.to
    ? month >= range.from && month <= range.to
    : month >= range.from || month <= range.to;
}

function isActive(rule: HoursRule, ctx: DateCtx): boolean {
  if (rule.monthRanges.length && !rule.monthRanges.some((r) => inMonthRange(ctx.month, r))) {
    return false;
  }
  if (rule.dateRanges.length && !rule.dateRanges.some((r) => inMonthDayRange(ctx.md, r))) {
    return false;
  }
  if (rule.weekdays && !rule.weekdays.has(ctx.weekday)) return false;
  return true;
}

/**
 * 规则的具体程度：
 * 2 = 带日期段/月份段（季节、节假日特殊安排等「这一天」的规则）
 * 1 = 带星期（周几开、周几闭）
 * 0 = 没有限定（每天都适用）
 */
function specificity(rule: HoursRule): number {
  if (rule.dateRanges.length || rule.monthRanges.length) return 2;
  if (rule.weekdays && rule.weekdays.size < 7) return 1;
  return 0;
}

function overlaps(a: MinutesWindow, b: MinutesWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

interface SelectedWindow {
  win: MinutesWindow;
  rule: HoursRule;
}

/**
 * 从所有「今天有效」的营业窗口规则里选出实际生效的窗口。
 *
 * 同一天可能有多组规则并存（真机样本）：
 * - 拙政园：季节日场（月份段）+ 周二至周日夜游（星期）——两者时段不相交，都该生效；
 * - 天平山：基础 08:00-17:00 + 2月15-23日 08:00-17:30——特殊日期规则**覆盖**基础规则。
 *
 * 处理方式：按具体程度从高到低收集；低具体度窗口与已选窗口重叠时，
 * 只有「已选窗口完整包含它」才认定为覆盖（让位）；否则视为无法判定的矛盾 → unknown。
 */
function selectWindows(rules: HoursRule[]): { selected: SelectedWindow[]; ambiguous: boolean } {
  const selected: SelectedWindow[] = [];
  let ambiguous = false;
  for (const level of [2, 1, 0]) {
    for (const rule of rules.filter((r) => specificity(r) === level)) {
      for (const win of rule.windows) {
        const conflicts = selected.filter((s) => overlaps(s.win, win));
        if (!conflicts.length) {
          selected.push({ win, rule });
          continue;
        }
        if (conflicts.every((c) => c.win.start <= win.start && c.win.end >= win.end)) {
          continue; // 更具体的规则完整覆盖该窗口 → 让位
        }
        // 同层重叠 / 具体规则比基础规则更窄（可能是「特殊日期缩短营业」，也可能是
        // 两条并行规则）——无法确定语义，整条 unknown。
        ambiguous = true;
      }
    }
  }
  return { selected, ambiguous };
}

/** 合并重叠/相邻窗口为连续时段，用于判断 [到达, 离开] 是否被「连续的营业时段」覆盖 */
function mergeWindows(windows: MinutesWindow[]): MinutesWindow[] {
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged: MinutesWindow[] = [];
  for (const w of sorted) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

function windowsText(windows: MinutesWindow[]): string {
  return windows.map((w) => `${fmtMin(w.start)}-${fmtMin(w.end)}`).join("、");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** 星期集合 → 人话（周几、连续区间，处理跨周如周六至周一） */
function weekdaySummary(days: Set<number>): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  if (sorted.length === 7) return "每天";
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end = sorted[i + 1];
      i += 1;
    }
    runs.push([start, end]);
  }
  // 跨周连续：首段从周一开始、末段到周日结束（如 周六、周日、周一）
  if (runs.length > 1 && runs[0][0] === 1 && runs[runs.length - 1][1] === 7) {
    const last = runs.pop()!;
    runs[0] = [last[0], runs[0][1]];
  }
  return runs
    .map(([a, b]) => (a === b ? WEEK_LABEL[a] : `${WEEK_LABEL[a]}至${WEEK_LABEL[b]}`))
    .join("、");
}

function withCaveat(reason: string, caveat: boolean): string {
  return caveat ? `${reason}；节假日以官方公告为准` : reason;
}

function closedReason(rule: HoursRule): string {
  if (rule.weekdays && rule.weekdays.size) {
    const phrase = /全天(?:不开放|闭馆|休息)/.test(rule.raw) ? "全天不开放" : "闭馆";
    return `${weekdaySummary(rule.weekdays)}${phrase}`;
  }
  // 只有日期段限定的闭馆（如「01/01-01/03 不开放」）：直接引用原文更不易失真
  return `当天闭馆（${truncate(rule.raw, RAW_REASON_MAX)}）`;
}

function evaluate(
  parsed: ParsedSchedule,
  ctx: DateCtx,
  startMin: number,
  endMin: number,
  usable: boolean,
): HoursCheck {
  if (!usable) return { state: "unknown" };
  const active = parsed.rules.filter((r) => r.kind !== "note" && isActive(r, ctx));
  const closedRules = active.filter((r) => r.kind === "closed");
  const windowRules = active.filter((r) => r.kind === "windows");

  // 1) 带日期/月份限定的闭馆：明确命中今天 → closed
  const dateClosed = closedRules.find((r) => r.dateRanges.length || r.monthRanges.length);
  if (dateClosed) {
    return { state: "closed", reason: withCaveat(closedReason(dateClosed), parsed.caveat) };
  }

  // 2) 选定实际生效的窗口
  const { selected, ambiguous } = selectWindows(windowRules);
  if (ambiguous) return { state: "unknown" }; // 多组规则互相矛盾，不猜

  // 3) 普通「周几闭馆」：优先于普通/周几营业窗口；
  //    但若今天有带日期/月份限定的营业窗口（特殊日期开放），说明当天另有安排 → 不判闭馆。
  const specialDateOpen = windowRules.some((r) => r.dateRanges.length || r.monthRanges.length);
  if (closedRules.length && !specialDateOpen) {
    return { state: "closed", reason: withCaveat(closedReason(closedRules[0]), parsed.caveat) };
  }

  if (!selected.length) return { state: "unknown" }; // 今天没有任何可判定的营业信息

  const wins = selected.map((s) => s.win);
  const text = windowsText(wins);
  const merged = mergeWindows(wins);

  // 4) 到达时刻必须在某个窗口内。窗口语义 [start, end)：到达时刻已到关门时间 = 进不去
  const containing = selected.filter((s) => startMin >= s.win.start && startMin < s.win.end);
  if (!containing.length) {
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (startMin < first.start) {
      return {
        state: "outside",
        reason: withCaveat(
          `营业时间 ${text}；${fmtMin(first.start)} 才开门，你 ${fmtMin(startMin)} 到`,
          parsed.caveat,
        ),
      };
    }
    if (startMin >= last.end) {
      return {
        state: "outside",
        reason: withCaveat(
          `营业时间 ${text}；${fmtMin(last.end)} 已关门，你 ${fmtMin(startMin)} 到`,
          parsed.caveat,
        ),
      };
    }
    // 落在两个营业时段之间（如午休闭店、日场与夜游之间清场）
    return {
      state: "outside",
      reason: withCaveat(
        `营业时间 ${text}，你 ${fmtMin(startMin)} 到，不在营业时段内`,
        parsed.caveat,
      ),
    };
  }

  // 5) 最后入场时刻：到达晚于「最晚进入 / 停止售票入馆」→ 进不去。
  //    取「覆盖到达时刻且结束最晚」的那条规则（季节/特殊日期的最后入场以实际生效规则为准）。
  const chosen = containing.reduce((a, b) => (b.win.end > a.win.end ? b : a));
  if (chosen.rule.lastEntry !== null && startMin > chosen.rule.lastEntry) {
    return {
      state: "outside",
      reason: withCaveat(
        `最晚进入 ${fmtMin(chosen.rule.lastEntry)}，你 ${fmtMin(startMin)} 到，已停止入场`,
        parsed.caveat,
      ),
    };
  }

  // 6) 离开时刻：必须落在与到达时刻同一段连续营业时段内（跨午休/清场不算开放）
  const segment = merged.find((m) => startMin >= m.start && startMin < m.end)!;
  if (endMin > segment.end) {
    return {
      state: "outside",
      reason: withCaveat(
        `营业时间 ${text}；${fmtMin(segment.end)} 关门，你安排的结束是 ${fmtMin(endMin)}`,
        parsed.caveat,
      ),
    };
  }

  return { state: "open" };
}

// ---------- 对外 API ----------

/** 名称是否自带停业状态（高德用名称表达：「金沙遗址博物馆(暂停开放)」） */
export function isTemporarilyClosedName(name: string): boolean {
  return typeof name === "string" && /暂停开放|暂停营业|已关闭/.test(name);
}

/**
 * 判断一个 POI 在指定日期的到达时间段「开不开门」。
 *
 * @param poi      营业时间来源（openTime2 优先：它含闭馆规则/季节/最晚进入；缺失才退回 openTime）
 * @param isoDate  到达日期 "YYYY-MM-DD"（本地日历日；星期按该日期算）
 * @param startMin 到达时刻（当天分钟数 0-1439）
 * @param endMin   离开时刻（当天分钟数，1-1440；必须 > startMin）
 *
 * 优先级：停业名称 → opentime2 解析（失败即 unknown，**不**退回 open_time：
 * 有更详细原文却读不懂时，用简版会丢掉闭馆信息）→ 无 opentime2 才用 open_time。
 * 任何异常（非法日期、NaN、不支持的跨零点营业时间）→ unknown，绝不抛错。
 */
export function checkOpenHours(
  poi: HoursPoiInput | null | undefined,
  isoDate: string,
  startMin: number,
  endMin: number,
): HoursCheck {
  try {
    if (!poi) return { state: "unknown" };
    const ctx = parseIsoDate(isoDate);
    if (!ctx) return { state: "unknown" };
    if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) return { state: "unknown" };
    if (startMin < 0 || startMin > 1439) return { state: "unknown" };
    if (endMin < 1 || endMin > 1440) return { state: "unknown" };
    if (endMin <= startMin) return { state: "unknown" };

    const name = typeof poi.name === "string" ? poi.name : "";
    const nameMarker = name.match(/暂停开放|暂停营业|已关闭/);
    if (nameMarker) {
      return { state: "closed", reason: `名称显示「${nameMarker[0]}」` };
    }
    if (poi.temporarilyClosed === true) {
      return { state: "closed", reason: "高德数据标记为暂停开放" };
    }

    const rich = asText(poi.openTime2);
    const text = rich ?? asText(poi.openTime);
    if (!text) return { state: "unknown" };
    const parsed = parseSchedule(text);
    if (!parsed) return { state: "unknown" };
    // rich 存在时绝不回退 open_time（见函数注释）
    return evaluate(parsed, ctx, startMin, endMin, true);
  } catch {
    // 红色底线：这个函数只回答「开门/关门/不知道」，永远不能把调用方一起弄崩
    return { state: "unknown" };
  }
}

/** 当天可用性：这一天到底有没有营业（与「几点到几点」无关）。
 *  open=当天有营业时段；closed=当天闭馆；unknown=数据不足/规则矛盾，不猜。 */
export type DayAvailability =
  { state: "open"; windows: string } | { state: "closed"; reason: string } | { state: "unknown" };

/**
 * 判断某个 POI 在指定日期**当天**是否营业（不看具体到达时刻）。
 *
 * 为什么需要它：checkOpenHours 回答的是「我 10:30 到，它开不开门」，
 * 而「事实先行」要回答的是另一个问题——**这一天它要不要被排除在行程之外**
 * （周一闭馆的博物馆，整天的周一都不能排）。用 checkOpenHours 问不出这个：
 * 09:00-17:00 的博物馆在 00:00 到达会得到「outside」（还没开门），
 * 而不是「closed」（今天不开）。两者的产品含义完全不同，不能混用。
 *
 * 判定口径与 checkOpenHours 的前 4 步完全一致（同一份解析结果、同样的
 * 具体度优先级、同样的「矛盾即 unknown」），只把「到达/离开时刻是否落在
 * 窗口内」换成「当天是否存在任何窗口」。
 *
 * 三态诚实红线：只有确信「当天闭馆」才返回 closed；节假日例外只提示
 * 「以官方公告为准」，不假装知道放假安排。
 */
export function checkDayAvailability(
  poi: HoursPoiInput | null | undefined,
  isoDate: string,
): DayAvailability {
  try {
    if (!poi) return { state: "unknown" };
    const ctx = parseIsoDate(isoDate);
    if (!ctx) return { state: "unknown" };

    const name = typeof poi.name === "string" ? poi.name : "";
    const nameMarker = name.match(/暂停开放|暂停营业|已关闭/);
    if (nameMarker) return { state: "closed", reason: `名称显示「${nameMarker[0]}」` };
    if (poi.temporarilyClosed === true) {
      return { state: "closed", reason: "高德数据标记为暂停开放" };
    }

    const rich = asText(poi.openTime2);
    const text = rich ?? asText(poi.openTime);
    if (!text) return { state: "unknown" };
    const parsed = parseSchedule(text);
    if (!parsed) return { state: "unknown" };

    const active = parsed.rules.filter((r) => r.kind !== "note" && isActive(r, ctx));
    const closedRules = active.filter((r) => r.kind === "closed");
    const windowRules = active.filter((r) => r.kind === "windows");

    // 1) 带日期/月份限定的闭馆：命中今天 → closed
    const dateClosed = closedRules.find((r) => r.dateRanges.length || r.monthRanges.length);
    if (dateClosed) {
      return { state: "closed", reason: withCaveat(closedReason(dateClosed), parsed.caveat) };
    }

    // 2) 选出今天实际生效的窗口（矛盾 → unknown，不猜）
    const { selected, ambiguous } = selectWindows(windowRules);
    if (ambiguous) return { state: "unknown" };

    // 3) 普通「周几闭馆」优先于营业窗口；但若今天有带日期/月份限定的
    //    营业窗口（特殊日期开放），说明当天另有安排 → 不判闭馆。
    const specialDateOpen = windowRules.some((r) => r.dateRanges.length || r.monthRanges.length);
    if (closedRules.length && !specialDateOpen) {
      return { state: "closed", reason: withCaveat(closedReason(closedRules[0]), parsed.caveat) };
    }

    // 4) 今天有窗口 → 当天开门（具体时刻是否来得及由 checkOpenHours 管）
    if (!selected.length) return { state: "unknown" };
    return { state: "open", windows: windowsText(selected.map((s) => s.win)) };
  } catch {
    // 红色底线：这个函数只回答「开/关/不知道」，永远不能把调用方一起弄崩
    return { state: "unknown" };
  }
}

/**
 * 提取简短人话的营业时间（UI 展示用），如「09:00-17:00，周一闭馆」。
 * 解析不出 / 内容无法用一句话概括（季节性分段、日期段规则、多组矛盾）→ undefined。
 *
 * 与 checkOpenHours 的取舍不同：判定可以 unknown 后由上层静默跳过，
 * 展示必须**确信**——所以含日期段/月份段的规则一律不简述。
 */
export function formatHoursShort(
  poi: (HoursPoiInput & Partial<SpotPoiMeta>) | null | undefined,
): string | undefined {
  try {
    if (!poi) return undefined;
    if (poi.temporarilyClosed === true) return "暂停开放";
    const name = typeof poi.name === "string" ? poi.name : "";
    const nameMarker = name.match(/暂停开放|暂停营业|已关闭/);
    if (nameMarker) return nameMarker[0];

    const text = asText(poi.openTime2) ?? asText(poi.openTime);
    if (!text) return undefined;
    const parsed = parseSchedule(text);
    if (!parsed) return undefined;

    const rules = parsed.rules.filter((r) => r.kind !== "note");
    if (!rules.length) return undefined;
    // 营业时间随季节/日期变化（如拙政园 1-2月/3-10月两套）：一句话必然失真
    if (rules.some((r) => r.dateRanges.length || r.monthRanges.length)) return undefined;

    const parts: string[] = [];
    for (const rule of rules) {
      if (rule.kind === "closed") {
        if (!rule.weekdays || !rule.weekdays.size) return undefined;
        const phrase = /全天(?:不开放|闭馆|休息)/.test(rule.raw) ? "全天不开放" : "闭馆";
        parts.push(`${weekdaySummary(rule.weekdays)}${phrase}`);
        continue;
      }
      const dayPrefix =
        rule.weekdays && rule.weekdays.size < 7 ? `${weekdaySummary(rule.weekdays)} ` : "";
      const single = rule.windows.length === 1 ? rule.windows[0] : null;
      const winText =
        single && single.start === 0 && single.end === 1440
          ? "全天开放"
          : windowsText(rule.windows);
      let part = `${dayPrefix}${winText}`;
      if (rule.lastEntry !== null) part += `，最晚进入 ${fmtMin(rule.lastEntry)}`;
      parts.push(part);
    }
    if (!parts.length) return undefined;

    const body = [...new Set(parts)].join("，");
    const out = parsed.caveat ? `${body}（节假日以官方公告为准）` : body;
    // UI 卡片空间有限：超出上限宁可不显示，也不截断成一句可能失真的人话
    return out.length <= SHORT_MAX_CHARS ? out : undefined;
  } catch {
    return undefined;
  }
}
