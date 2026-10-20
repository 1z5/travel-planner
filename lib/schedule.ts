import type { Plan, PlanDay, PlanInput, PlanLeg, TransportMode } from "./types";

// ============================================================
// 时间轴可执行性：检测「时间接不上」+ 确定性顺延（不用模型、不扣配额）。
//
// 为什么单独一个模块（而不是塞进 server-only 的 validate.ts）：
// 1) 判定口径必须只有一个来源——体检（validateDay）、重排（retimeDay）、
//    只刷新这两类预警（refreshTimeWarnings）共用同一份实现。否则会出现
//    「体检说接不上、顺延后还接不上」这种自相矛盾，用户不知道该信谁。
// 2) 客户端组件（结果页的时间轴展示/一键顺延入口）也要能用，所以不能
//    import server-only 模块。
//
// 「不猜」原则在本模块的具体落法：
// - 时间串解析不出来 → 不判定（返回 null / 跳过该点对），不拿默认值编；
// - 缺 leg（没验真/旧行程）→ 不判定也不顺延，由调用方提示「没有真实路段数据」；
// - 缺出发日期 → 算不出活动落在哪一天，不拿「刚好同名」硬钉锚点。
// ============================================================

/** 分钟数 → "HH:MM"（补零；只接受 0-1439，越界由调用方先挡） */
function fmtHourMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 解析 spot.time（"HH:MM-HH:MM"）→ 当天的分钟数区间。
 *
 * 与 trip-day.parseRange 同思路（同为 client-safe、同样容错 1-2 位小时），
 * 但这里对「非法」更严格——**跨零点/零长一律返回 null**：
 * 顺延要拿上一个点的 end 当下一段的起点，end <= start 时没有合法的同日
 * 区间可推（23:00-01:00 如果猜成「+24h 再取模」，等于替用户假设了跨天停留，
 * 而行程点是「当天某段停留」，跨零点本身就该由人确认）。
 *
 * @param time 形如 "09:00-11:30"；"9:30-11:00" 也接受
 * @returns { start, end }（均为当天分钟数）或 null（格式非法 / 越界 / 跨零点 / 零长）
 */
export function parseTimeRange(time: string): { start: number; end: number } | null {
  const m = String(time ?? "").match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  // 分/时越界必须单独挡：「25:00」乘出来是 1500 分钟，靠 end<1440 判断
  // 碰巧能挡，但「24:00」算出来恰好 1440 会漏过去——它同样不是合法的时刻
  if (sm > 59 || em > 59 || sh > 23 || eh > 23) return null;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null; // 跨零点 / 零长
  return { start, end };
}

/** 相邻点对的唯一键：from/to 名称匹配用。用 NUL 分隔，避免名字里出现 "→" 之类造成碰撞 */
function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** 一段「时间接不上」的冲突（相邻两点之间，有真实 leg 但时间不够） */
export interface ScheduleConflict {
  from: string; // 上一站名称
  to: string; // 下一站名称
  gapMin: number; // 两点的间隔（next.start - cur.end；负值=时间重叠）
  needMin: number; // 这段路至少需要多少分钟（durationSec 向上取整到分钟）
  fromEnd: string; // 上一站结束 "HH:MM"
  toStart: string; // 下一站开始 "HH:MM"
  mode: TransportMode; // 该 leg 的交通方式（文案里要说清「驾车约需 22 分钟」）
}

/**
 * 检查一天的「时间接不上」冲突。
 *
 * 只检查**相邻且存在 leg** 的点对：
 * - leg 按 from/to 名称匹配（同一天出现同名点极罕见，重复时以第一条为准）；
 * - 缺 legs 直接返回 []——没有真实路段就没有判定依据，不能按「0 分钟」假设
 *   成「全部接得上」（那是在假装体检通过）；
 * - 缺某一段 leg（该点没验真到坐标、连不成链）→ 跳过该对，不拿别的段顶替。
 *
 * 判定：gapMin < needMin 即冲突。gapMin 为负说明两段时间本身就重叠，
 * 物理上更不可能，同样要报（文案里会说「重叠 N 分钟」而不是「只有 -5 分钟」）。
 * 按当天点位顺序返回，供「每天汇总一条」的预警使用。
 */
export function checkDaySchedule(day: PlanDay): ScheduleConflict[] {
  const legs = day.legs;
  if (!legs?.length) return [];
  const byPair = new Map<string, PlanLeg>();
  for (const leg of legs) byPair.set(pairKey(leg.from, leg.to), leg);

  const conflicts: ScheduleConflict[] = [];
  for (let i = 0; i < day.spots.length - 1; i++) {
    const cur = day.spots[i];
    const next = day.spots[i + 1];
    const leg = byPair.get(pairKey(cur.name, next.name));
    // durationSec 非法（NaN/负数/缺失）时无法得到可信的 needMin——跳过，不猜
    if (!leg || !Number.isFinite(leg.durationSec) || leg.durationSec < 0) continue;
    const a = parseTimeRange(cur.time);
    const b = parseTimeRange(next.time);
    // 时间解析不了就不判定：错在时间格式，不该在这里报成「路段冲突」
    if (!a || !b) continue;
    const gapMin = b.start - a.end;
    // 向上取整：22 分 5 秒按 23 分钟要求——宁可多留 1 分钟，不能少留
    const needMin = Math.ceil(leg.durationSec / 60);
    if (gapMin < needMin) {
      conflicts.push({
        from: cur.name,
        to: next.name,
        gapMin,
        needMin,
        fromEnd: fmtHourMin(a.end),
        toStart: fmtHourMin(b.start),
        mode: leg.mode,
      });
    }
  }
  return conflicts;
}

/** 顺延失败/无法顺延的原因码：路由据此映射 400/422（而不是把内部错误透给用户） */
export type RetimeUnavailableCode = "day_not_found" | "missing_start_date" | "no_route_data";

/**
 * 无法确定性顺延（不是内部崩溃）。message 面向用户，可直接作为 422/400 文案。
 * 用独立错误类型而不是返回 changed=false：前端/路由需要区分
 * 「本来就接得上（无需修改）」和「没有数据可依据（不能假装能修）」。
 */
export class RetimeUnavailableError extends Error {
  readonly code: RetimeUnavailableCode;

  constructor(code: RetimeUnavailableCode, message: string) {
    super(message);
    this.name = "RetimeUnavailableError";
    this.code = code;
  }
}

/** 顺延结果：只返回被处理的那一天；changed=false 表示重排后与原来逐字符相同（幂等） */
export interface RetimeResult {
  day: PlanDay;
  changed: boolean;
  notes: string[];
}

// ---------- 日期工具（client-safe：不能复用 server-only 的 validate.addDays/isRealDate） ----------

/** 合法日历日期：格式对且能 round-trip（挡掉 2026-02-30 / 2026-13-01） */
function isRealDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // 先挡 NaN：月越界给 Invalid Date，直接 toISOString 会抛 RangeError
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** "YYYY-MM-DD" 相差天数（to - from，UTC 算术避免时区漂移；非法返回 null） */
function daysBetween(from: string, to: string): number | null {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** "HH:mm" → 当天分钟数；非法返回 null（活动时间格式不猜） */
function parseClock(hhmm: string): number | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 名称匹配（与 validate.ts 的 nameCovered 同口径）：
 * 用户写简称、行程落成场馆全称是正确执行，必须能被锚点识别出来。
 *
 * 为什么复制一份而不是 import：validate.ts 是 server-only，本模块要 client-safe。
 * **改阈值时两处必须一起改**（tests/lib/schedule.test.ts 与
 * tests/lib/validate.test.ts 都钉了同一组样本）。
 * 规则：双向包含，或最长公共子串 ≥3 字。
 */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

function namesMatch(a: string, b: string): boolean {
  const x = String(a ?? "").trim();
  const y = String(b ?? "").trim();
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return longestCommonSubstring(x, y) >= 3;
}

/**
 * 收集「固定时间活动」锚点：spotIndex → 活动开始分钟数。
 *
 * 只认**同时给了 date 和 time** 的活动：
 * - 缺 time：不是固定时间活动，没有锚点语义；
 * - 缺 date：算不出活动落在哪一天。不能因为「第 N 天刚好有个同名点」就把它
 *   钉到那个时间——那是替用户猜活动日期（活动日期是买定离手的硬信息）。
 *
 * 日期换算：第 N 天 = startDate + (N-1) 天，与 validate.finalizePlan 的活动
 * 日期校验、天气/ics 的日期口径完全一致。
 */
function collectAnchors(plan: Plan, input: PlanInput, day: PlanDay): Map<number, number> {
  const anchors = new Map<number, number>();
  const startDate = plan.startDate;
  if (!isRealDate(startDate)) return anchors;
  for (const ev of input.events ?? []) {
    if (!ev.time || !ev.date || !isRealDate(ev.date)) continue;
    const diff = daysBetween(startDate, ev.date);
    if (diff === null || diff + 1 !== day.day) continue;
    const startMin = parseClock(ev.time);
    if (startMin === null) continue;
    const idx = day.spots.findIndex((s) => namesMatch(ev.name, s.name));
    if (idx < 0) continue;
    // 同一天多个活动命中同一个 spot：时间互相矛盾，没有可行解——保留先出现的
    // 那个（用户输入顺序即优先级），不猜哪个才是对的
    if (!anchors.has(idx)) anchors.set(idx, startMin);
  }
  return anchors;
}

/**
 * 确定性顺延一天的时间轴：**只改 time，不碰 durationMin/顺序/内容**。
 *
 * 规则（与产品口径对齐）：
 * 1. 首点保持原来的开始时间（用户可能特意早起；顺延的语义是「后面被堵住的
 *    往后挪」，不是重新规划出发时间）；
 * 2. 之后每点 start = 上一点 end + 该段 leg 分钟数（无 leg 则 +0），
 *    end = start + durationMin；
 * 3. 固定时间活动（input.events 带 date+time 且落在该天、名称匹配）钉在活动
 *    时间上；若纯顺延结果会晚于锚点，保留锚点并从它继续，notes 说明原因；
 * 4. 顺延后超过 23:59：不生成非法时间（没有 24:10 这种 "HH:MM"），保留已排好
 *    的前缀、其余点维持原样，notes 建议减少 1 个点；
 * 5. 幂等：对顺延结果再调用一次必须 changed=false（second call 是 e2e 断言）。
 *
 * 无法顺延（throw RetimeUnavailableError，供路由映射 422）：
 * - 没有第 N 天（正常流程路由已先校验，这里是防御）
 * - 缺合法的 plan.startDate（无法确定活动落在哪天，不能瞎钉锚点）
 * - 当天 ≥2 个点但没有可用 legs（未验真/旧版本/MOCK）——没有真实路段就
 *   无依据；按 0 分钟硬排等于假装「全都接得上」
 * 其余「可以但不该动」的情况（当天 0/1 个点、首点时间解析不出）返回
 * changed=false + notes：这是「无需/无法顺延」而非「数据缺失」。
 *
 * 纯函数：不修改入参 plan（返回的 day 是新对象；未变动时引用原 day）。
 *
 * @param plan       完整行程（只读 plan.startDate / plan.days 里目标那天）
 * @param input      用户输入（读 events 做固定时间锚点）
 * @param dayNumber  目标天（1 基，与 plan.days[].day 一致）
 */
export function retimeDay(plan: Plan, input: PlanInput, dayNumber: number): RetimeResult {
  const day = plan.days.find((d) => d.day === dayNumber);
  if (!day) {
    throw new RetimeUnavailableError(
      "day_not_found",
      `这份行程没有第 ${dayNumber} 天（共 ${plan.days.length} 天），无法顺延时间轴`,
    );
  }
  const notes: string[] = [];
  const spots = day.spots;
  if (spots.length === 0) {
    return { day, changed: false, notes: ["当天没有行程点，无需顺延时间轴"] };
  }
  if (spots.length === 1) {
    return { day, changed: false, notes: ["当天只有 1 个行程点，没有需要顺延的路段"] };
  }

  if (!isRealDate(plan.startDate)) {
    throw new RetimeUnavailableError(
      "missing_start_date",
      "这份行程缺少合法的出发日期（startDate），无法确认固定时间活动落在哪一天，不能自动顺延时间轴",
    );
  }
  const startDate = plan.startDate;

  // 首点时间：保留它的 start。解析不出就没有顺延的起点——不猜 9:00，直接说清
  const first = parseTimeRange(spots[0].time);
  if (!first) {
    return {
      day,
      changed: false,
      notes: [
        `第 ${dayNumber} 天第一个行程点「${spots[0].name}」的时间「${spots[0].time}」无法识别，未做顺延`,
      ],
    };
  }

  // 相邻点对的路段分钟数（按名称匹配）。缺 leg 的段按 0 分钟衔接（顺延规格），
  // 但会在 notes 里点明有几段缺数据——不假装整条链都是真实通勤
  const travelByPair = new Map<string, number>();
  for (let i = 0; i < spots.length - 1; i++) {
    const leg = day.legs?.find((l) => l.from === spots[i].name && l.to === spots[i + 1].name);
    if (leg && Number.isFinite(leg.durationSec) && leg.durationSec >= 0) {
      travelByPair.set(pairKey(spots[i].name, spots[i + 1].name), Math.ceil(leg.durationSec / 60));
    }
  }
  if (travelByPair.size === 0) {
    throw new RetimeUnavailableError(
      "no_route_data",
      "这份行程没有与当天点位匹配的真实路段数据（未验真或旧版本），无法自动顺延时间轴",
    );
  }
  const missingSegments = spots.length - 1 - travelByPair.size;
  if (missingSegments > 0) {
    notes.push(
      `第 ${dayNumber} 天有 ${missingSegments} 段缺少真实路段数据，顺延时按 0 分钟衔接，实际请留出缓冲`,
    );
  }

  const anchors = collectAnchors(plan, input, day);
  const times: string[] = spots.map((s) => s.time);
  let cursor = first.start;
  let overflowAt = -1;

  for (let i = 0; i < spots.length; i++) {
    const spot = spots[i];
    // durationMin 是「停留分钟数」的权威值，time 只是它的展示；非法值按 0 处理
    // 而不是拿原始 time 区间长度反推（那会把数据错误藏起来）
    const rawDur = Number(spot.durationMin);
    const dur = Number.isFinite(rawDur) ? Math.max(0, Math.round(rawDur)) : 0;

    let start = cursor;
    const anchor = anchors.get(i);
    if (anchor !== undefined) {
      // 锚点与纯顺延冲突：用户买定离手的是活动时间，重排只能让位于它。
      // 代价是前一站可能与它重叠——这是无法两全的约束，如实说明，不偷偷改活动
      if (anchor < cursor) {
        notes.push(`「${spot.name}」是固定时间活动，已按它的时间排`);
      }
      start = anchor;
    }

    const end = start + dur;
    // 24:00（1440）不是合法时刻：>=1440 即视为「顺延溢出」，后面的点不再动
    if (start >= 1440 || end >= 1440) {
      overflowAt = i;
      break;
    }
    times[i] = `${fmtHourMin(start)}-${fmtHourMin(end)}`;
    cursor = end + (travelByPair.get(pairKey(spot.name, spots[i + 1]?.name ?? "")) ?? 0);
  }
  if (overflowAt >= 0) {
    notes.push(`第 ${dayNumber} 天顺延后已超出当天 24:00，建议减少 1 个点`);
  }

  const changed = times.some((t, i) => t !== spots[i].time);
  if (!changed) return { day, changed: false, notes };

  // 只新建被改的那一天，其余天保持原引用——路由据此替换单天即可
  return {
    day: { ...day, spots: spots.map((s, i) => ({ ...s, time: times[i] })) },
    changed: true,
    notes,
  };
}

// ---------- 预警分类：只刷新「时间轴 / 营业时间」这两类时用 ----------

/**
 * 是不是时间轴类预警（validate 生成的那条「时间接不上」汇总）。
 *
 * 只认「时间接不上」这个标记词，**不**认「一键顺延」：营业时间预警里也会
 * 出现「建议用『一键顺延』调整时间」，用「一键顺延」判定会把营业预警误
 * 归成时间轴（两类都可能需要刷新，但语义上必须分开，方便前端/日志排障）。
 */
export function isScheduleWarning(warning: string): boolean {
  return String(warning ?? "").includes("时间接不上");
}

/**
 * 是不是营业时间类预警（闭馆 / 才开门 / 暂停开放 / 营业时间）。
 *
 * 与 warn-tag.ts 的「营业」标签口径一致；先排除时间轴预警，避免两类的
 * 标记词未来出现交叉时把同一条预警算两次。
 */
export function isHoursWarning(warning: string): boolean {
  const w = String(warning ?? "");
  if (isScheduleWarning(w)) return false;
  return (
    w.includes("闭馆") || w.includes("才开门") || w.includes("暂停开放") || w.includes("营业时间")
  );
}
