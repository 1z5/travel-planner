import { checkOpenHours, type HoursPoiInput } from "./poi-hours";
import { parseTimeRange } from "./schedule";
import type { PlanLeg, PlanSpot } from "./types";

// ============================================================
// 行中重规划求解器（确定性 · client-safe 纯函数 · 绝不调 LLM）
//
// 场景：出行当天，你站在路口问「接下来怎么走」。已知：现在几点、你在哪、
// 今天还没走的点、真实路段耗时、各点营业时间、以及不能迟到的固定活动。
// 求：一个**可行**的子序列（顺序 + 新时刻），并把「放弃了什么、为什么」
// 显式列出来。
//
// 为什么是确定性求解而不是调模型：这是约束满足问题（时间窗 + 旅行时间 +
// 固定锚点）。LLM 解它又慢（出行当场等不起）又会编（「你可以在路上顺便
// 看看」这种话没有约束力），而且「为什么放弃」必须引用真实约束数据
// （闭馆时间、路程分钟）——模型的措辞不可信。本项目 lib/schedule.ts 的
// 冲突检测/顺延是同一条路，本模块是它的扩展：顺延只挪时间，求解器还要
// 决定**去不去**。
//
// 三条红线在本模块的落法：
// 1. 确定性：只做算术 + 复用 checkOpenHours 的真实营业时间判定；
// 2. 不自动改行程：本函数只返回建议（调用方不落库），放弃的点逐条列出
//    理由——没有「悄悄删掉」这回事；
// 3. 只对未来的点负责：spots 由调用方先过滤掉已走过/正在走的点（正在走
//    的点通过 from 告知求解器「你现在在这」）。
//
// 「不猜」原则：
// - 没有任何真实路段 → ok:false + 明确降级（不按 0 分钟假装接得上）；
// - 某一段 leg 缺失 → 按 0 分钟衔接**并记入 notes 摊开说明**（与
//   schedule.retimeDay 同口径：宁可披露缺口，也不假装整条链都是真实通勤）；
// - 营业时间读不懂 → 保留（unknown 不判，与体检同口径）；
// - 时间会排过 24:00 → 没有「25:00」这种时刻，丢弃并说明。
// ============================================================

/** 求解输入。spots/legs 都是「只读快照」，本函数不修改入参 */
export interface ReplanInput {
  /** 现在（当天分钟数，0-1439，如 930 = 15:30）。调用方按用户本地时钟给出 */
  nowMin: number;
  /** 今天还没走的行程点（已走过/正在走的点已由调用方过滤） */
  spots: PlanSpot[];
  /** 当天全部真实路段（按 from/to 名称匹配；没有则 ok:false 降级） */
  legs: PlanLeg[];
  /**
   * 你现在所在（或刚刚离开）的点。
   * - name：查「从这到下一站」的 leg 用；缺 leg 按 0 分钟 + notes 披露；
   * - endMin：该点原定结束时间。给它的含义是「你正在这个点里，最早也要
   *   等它结束才能动身」——正在走的点不可重排，它的原定结束时间是最早
   *   出发时刻；已走过的点不用给（那时 nowMin 就是最早出发时刻）。
   */
  from?: { name: string; endMin?: number };
  /**
   * 营业时间约束：到达日期 + 各点的 POI 营业时间来源。
   * 求解器在**算出到达/离开时刻之后**才判定开不开门（时刻是求解结果，
   * 没法预先判定），所以这里给数据而不是给结论。
   */
  hours?: {
    isoDate: string; // 到达日期 "YYYY-MM-DD"（checkOpenHours 按它算星期）
    byName: Record<string, HoursPoiInput | undefined>; // spot 名称 → 营业时间来源
  };
  /** 固定活动（演唱会/球赛/航班…）：不可移动的墙。time 形如 "19:00" */
  anchor?: { time: string; name: string };
}

/** 保留的点：原行程点 + 求解出的新时刻 "HH:MM-HH:MM" */
export interface ReplanKept {
  spot: PlanSpot;
  newTime: string;
}

/** 放弃的点：名称 + 理由（理由必须引用真实约束：闭馆时间/路程分钟/锚点时间） */
export interface ReplanDropped {
  name: string;
  reason: string;
}

export interface ReplanResult {
  /**
   * false = 缺真实路程数据无法求解（诚实降级，调用方给 422）；
   * true = 求解完成。注意 kept 为空也是 ok:true——「按现在的约束一个点都
   * 保不住」是合法的求解结果，只有「没有数据可依据」才是 ok:false。
   */
  ok: boolean;
  kept: ReplanKept[];
  dropped: ReplanDropped[];
  /** 数据缺口等说明（不阻塞求解，但必须摊开给用户看） */
  notes: string[];
  /** ok:false 时的降级原因；或「今天已走完」之类的良性说明 */
  message?: string;
}

// ---------- 小工具（与 schedule.ts 重复的部分见各函数注释） ----------

/** 分钟数 → "HH:MM"；1440 渲染为 "24:00"（锚点跨零点的极端情况用） */
function fmtHourMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 相邻点对的唯一键：名称匹配用。NUL 分隔避免名字里出现 "→" 造成碰撞（同 schedule.ts） */
function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** "HH:mm" → 当天分钟数；非法返回 null（锚点时间不猜） */
function parseClock(hhmm: string): number | null {
  const m = String(hhmm ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 名称匹配（与 lib/schedule.ts 的 namesMatch 同口径，此处复制一份）：
 * 用户写简称、行程落成全称是正确执行，必须能被锚点识别（「川剧变脸」↔
 * 「蜀风雅韵川剧变脸演出(琴台路店)」）。规则：双向包含，或最长公共子串 ≥3 字。
 *
 * 为什么复制而不是 import：schedule.ts 没导出它，而它 import 的类型链
 * 与本模块一致；改阈值时两处必须一起改（本文件与 schedule 各自的测试
 * 都钉了同组样本）。
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

/** 行程点名称与锚点名称是否指同一个地点（导出供路由判断锚点是否已走过） */
export function matchSpotName(spotName: string, anchorName: string): boolean {
  const x = String(spotName ?? "").trim();
  const y = String(anchorName ?? "").trim();
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return longestCommonSubstring(x, y) >= 3;
}

/** 停留分钟数的权威值：非法按 0 处理（不拿原始 time 区间长度反推——那会把数据错误藏起来，同 retimeDay 口径） */
function durationOf(spot: PlanSpot): number {
  const raw = Number(spot.durationMin);
  return Number.isFinite(raw) ? Math.max(0, Math.round(raw)) : 0;
}

/**
 * 求解「接下来怎么走」。纯函数：不修改入参，不碰网络/存储。
 *
 * 算法（按当前顺序贪心，不重排用户选好的顺序）：
 * 1. 行进：从上一站（或 from 给出的当前位置）到这个点，按真实 leg 收分钟
 *    数（向上取整，宁可多算 1 分钟不能少算，同 checkDaySchedule 口径）；
 *    缺 leg → 0 分钟 + notes 披露；
 * 2. 墙：固定活动开始前，这个点必须走得完、且赶得到现场（含从它到现场的
 *    真实路程）；赶不上 → 丢弃并给出引用锚点时间与路程分钟的理由；
 * 3. 营业时间：到达/离开时刻算出后用 checkOpenHours 判定——闭馆/到点关
 *    门 → 丢弃并引用真实营业数据；unknown → 保留（读不懂就不判）；
 * 4. 24:00：排不下当天的点丢弃并说明；
 * 5. 锚点本身：钉死在活动时间上（用户买定离手），跳过上述判定——它的
 *    时间不可移动，判定它开不开门也改变不了什么（行程级体检已覆盖闭馆）。
 *
 * 丢弃一个点后 cursor 不动（你没去过那里），后面的点继续贪心——这就是
 * 「放弃显式列出」：每个放弃都有独立理由，不连坐。
 */
export function replanSolve(input: ReplanInput): ReplanResult {
  const spots = Array.isArray(input.spots)
    ? input.spots.filter(
        (s): s is PlanSpot => Boolean(s) && typeof s.name === "string" && s.name !== "",
      )
    : [];

  // 没有可重排的点：这不是失败——今天确实走完了，明确说清楚
  if (spots.length === 0) {
    return {
      ok: true,
      kept: [],
      dropped: [],
      notes: [],
      message: "今天剩下的行程点都已走完，无需重排",
    };
  }

  // 没有任何真实路段：不知道两点之间要走多久。按 0 分钟硬排等于假装
  // 「全都接得上」——那是编数据。MOCK 模式/境外/旧行程走这里降级。
  const byPair = new Map<string, PlanLeg>();
  for (const leg of Array.isArray(input.legs) ? input.legs : []) {
    if (leg && typeof leg.from === "string" && typeof leg.to === "string" && leg.from && leg.to) {
      if (!byPair.has(pairKey(leg.from, leg.to))) byPair.set(pairKey(leg.from, leg.to), leg);
    }
  }
  const hasUsableLeg = [...byPair.values()].some(
    (l) => Number.isFinite(l.durationSec) && l.durationSec >= 0,
  );
  if (!hasUsableLeg) {
    return {
      ok: false,
      kept: [],
      dropped: [],
      notes: [],
      message: "缺少真实路程数据，无法重排（这份行程没有真实路段：未验真/境外/旧版本行程）",
    };
  }

  // nowMin 不合法：调用方（路由）本应先校验，这里防御性挡住，不拿默认时间编
  if (!Number.isFinite(input.nowMin) || input.nowMin < 0 || input.nowMin > 1439) {
    return { ok: false, kept: [], dropped: [], notes: [], message: "当前时间不合法，无法重排" };
  }

  const notes: string[] = [];
  const kept: ReplanKept[] = [];
  const dropped: ReplanDropped[] = [];
  const notedPairs = new Set<string>();

  /** 上一站 → 这一站的行进分钟；缺 leg 按 0 分钟并在 notes 里披露（每个点对只说一次） */
  const travelMin = (fromName: string, toName: string): number => {
    const leg = byPair.get(pairKey(fromName, toName));
    if (leg && Number.isFinite(leg.durationSec) && leg.durationSec >= 0) {
      // 向上取整：22 分 5 秒按 23 分钟要求——宁可多留 1 分钟，不能少留
      return Math.ceil(leg.durationSec / 60);
    }
    const key = pairKey(fromName, toName);
    if (!notedPairs.has(key)) {
      notedPairs.add(key);
      notes.push(`缺少「${fromName} → ${toName}」的真实路段数据，按 0 分钟估算，实际请留出缓冲`);
    }
    return 0;
  };

  // ---------- 锚点（墙）----------
  // 活动已开始/已结束就不再是墙（你已经在现场，剩下的点排在它之后，
  // 而不是被一堵过去的墙挡死）；时间解析不出的活动不猜。
  let wall: { name: string; min: number; spotName?: string } | undefined;
  const anchor = input.anchor;
  if (anchor) {
    const min = parseClock(anchor.time);
    if (min === null) {
      notes.push(`固定活动「${anchor.name}」的时间「${anchor.time}」无法识别，未当作不可移动的墙`);
    } else if (min <= input.nowMin) {
      notes.push(`固定活动「${anchor.name}」${anchor.time} 已开始或结束，不再当作墙`);
    } else {
      const anchorSpot = spots.find((s) => matchSpotName(s.name, anchor.name));
      wall = { name: anchor.name, min, spotName: anchorSpot?.name };
      // 活动不在当天行程点里（外部活动）：算不出「从这到现场」的真实路程，
      // 墙只能保证「活动开始前结束」——如实披露这个缺口
      if (!wall.spotName) {
        notes.push(
          `固定活动「${anchor.name}」不在当天的行程点里，无法计入到现场的路程，只保证在它开始前结束`,
        );
      }
    }
  }

  // 出发时刻：正在进行中的点要等它原定结束（你还在里面，动不了）；
  // 否则就是「现在」。首站从这直接排起，路上时间未知时如实披露。
  let cursor =
    input.from && typeof input.from.endMin === "number" && input.from.endMin > input.nowMin
      ? input.from.endMin
      : input.nowMin;
  let lastName: string | null = input.from?.name ?? null;
  if (!lastName) {
    notes.push("首站从当前时间直接排起，未计入从你现在的位置出发的路程");
  }
  let anchorPinned = false;

  for (const spot of spots) {
    const dur = durationOf(spot);
    const travel = lastName ? travelMin(lastName, spot.name) : 0;
    const start = cursor + travel;

    // 锚点本身：钉死在活动时间上。晚于推算时间也照钉（活动时间不可动），
    // 只把「本来会迟到」这件事记进 notes——不偷偷改活动，也不偷偷砍它。
    if (wall && matchSpotName(spot.name, wall.name)) {
      const pinStart = wall.min;
      const pinEnd = pinStart + dur;
      if (start > pinStart) {
        notes.push(`「${spot.name}」是固定活动，已按它的时间 ${anchor?.time ?? ""} 排`);
      }
      kept.push({ spot, newTime: `${fmtHourMin(pinStart)}-${fmtHourMin(pinEnd)}` });
      cursor = pinEnd;
      lastName = spot.name;
      anchorPinned = true;
      continue;
    }

    const end = start + dur;

    // 墙：固定活动开始前，这个点必须走得完 + 赶得到现场。
    // 「赶得到」= 这个点结束后还有的时间 ≥ 从它到活动场地的真实路程。
    if (wall && !anchorPinned) {
      const need = wall.spotName ? travelMin(spot.name, wall.spotName) : 0;
      const left = wall.min - end;
      if (left < need) {
        const travelText = need > 0 ? `，从这过去还要 ${need} 分钟` : "";
        const reason =
          left >= 0
            ? `到 ${fmtHourMin(wall.min)} 的固定活动「${wall.name}」只剩 ${left} 分钟${travelText}`
            : `「${spot.name}」会排到 ${fmtHourMin(end)} 才结束，固定活动「${wall.name}」${fmtHourMin(wall.min)} 就开始${travelText}`;
        dropped.push({ name: spot.name, reason });
        continue; // 没去成这个点，cursor 不动
      }
    }

    // 营业时间：到达/离开时刻已算出，用真实营业数据判「进不进得去」。
    // closed/outside → 丢弃，reason 直接引用高德营业时间原文派生的结论。
    if (input.hours) {
      const poi = input.hours.byName?.[spot.name];
      if (poi) {
        const check = checkOpenHours(poi, input.hours.isoDate, start, end);
        if (check.state === "closed" || check.state === "outside") {
          dropped.push({ name: spot.name, reason: check.reason });
          continue; // 没去成这个点，cursor 不动
        }
        // open / unknown 都保留：unknown = 营业时间读不懂，不判（与体检同口径）
      }
    }

    // 当天 24:00 放不下：没有「25:00」这种时刻，丢弃并说明
    if (start >= 1440 || end >= 1440) {
      dropped.push({
        name: spot.name,
        reason: `时间会排到 ${fmtHourMin(end)}，超过当天 24:00，当天放不下`,
      });
      continue;
    }

    kept.push({ spot, newTime: `${fmtHourMin(start)}-${fmtHourMin(end)}` });
    cursor = end;
    lastName = spot.name;
  }

  return { ok: true, kept, dropped, notes };
}
