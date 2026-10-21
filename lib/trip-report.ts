// 旅程报告（/r/<token>）的纯函数层：把一份行程汇总成「值得截图传播」的统计。
//
// 为什么单独一个模块而不是塞进 budget.ts：报告页是 post-trip 传播物与留存钩子，
// 它要的数字（站点数/路程/餐饮清单/报告状态）与预算透视是两套叙事；但同源——
// 全部来自 plan 真实字段，一个字段都不得由本模块发明。
//
// 诚实口径（命门，逐条对齐任务红线）：
// - 缺失即缺省：没有 legs → distanceKm/walkDistanceKm 为 undefined，组件据此
//   不渲染该格子——「0 公里」与「没有路程数据」是两件事，编 0 就是撒谎；
// - 不编造回忆：没有行中确认数据，报告只陈述「行程包含什么」，绝不写「打卡了
//   X 个点」（那种叙事需要 check-in 数据，本产品没有采集）；
// - 去重口径：同一家餐厅/同一个景点出现多次算「一个站点、多笔花费」——站点数
//   是地理意义上的去重，花费是实际发生的逐项合计，两者各自诚实；
// - 时区口径：status 的「今天」由调用方按本地时区给出（todayIso 参数）——
//   服务端 UTC 会把 UTC+8 的清晨算成前一天。报告页因此与 TodayView 同一模式：
//   组件挂载后用 localTodayIso() 才判定状态，SSR 首屏不含状态条。
//
// client-safe：只 import type 与 lib/trip-day（同为纯函数），结果页/分享页的
// 客户端组件可以直接 import（参照 lib/budget.ts 的分层理由）。

import type { Plan, SpotType } from "./types";
import { tripToday } from "./trip-day";

/** 报告状态：由「今天」与行程起止日期比较得出（本地日期口径，客户端判定） */
export type TripReportStatus = "upcoming" | "ongoing" | "past" | "unknown";

/** 报告里的一个站点（去重后）。day = 它第一次出现的那一天 */
export interface ReportSpot {
  name: string;
  type: string; // SpotType | 运行时脏数据的其它值（组件用展示标签兜底）
  costCny: number; // 取整后；负数/非数字按 0 计（见 sanitizeCost）
  day: number;
}

export interface TripReport {
  city: string;
  days: number; // 行程天数（plan.days.length）
  startDate?: string; // 合法日历日期才回传；非法/缺失 = 没有这个字段（组件不渲染日期）
  endDate?: string;
  status: TripReportStatus; // todayIso 未传（SSR 首屏）→ "unknown"，不猜
  spotCount: number; // 去重后站点数
  sightCount: number; // 去重后景点数
  foodCount: number; // 去重后餐饮数
  totalCostCny: number; // 逐项合计（取整后），与 lib/budget.ts 同口径
  distanceKm?: number; // 所有 legs 距离合计（公里，一位小数）；无 legs → undefined
  walkDistanceKm?: number; // 仅 walking 的 legs 合计；非步行模式 → undefined
  spots: ReportSpot[]; // 去重后站点列表（餐饮清单与站点展示用）
}

/** UTC 午夜的毫秒数；非法日期（格式错/日历不存在，如 2026-02-30）返回 null */
function isoMs(iso: unknown): number | null {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const ms = new Date(`${iso}T00:00:00Z`).getTime();
  // 必须先挡 NaN：月越界给的是 Invalid Date，直接 toISOString 会抛
  if (Number.isNaN(ms)) return null;
  // round-trip 对不上 = 日历上不存在的日期（2026-02-30 会被静默滚成 3 月 2 日）
  if (new Date(ms).toISOString().slice(0, 10) !== iso) return null;
  return ms;
}

/**
 * 金额清洗：非数字/NaN/负数 → 0。
 * 为什么不静默保留：负花费是脏数据，若直接进合计会让总数变小、百分比失真；
 * 与 budget.ts 的 roundMoney 同口径（那边额外在 notes 里如实说明，报告页只
 * 做汇总，不逐条摊开——异常值影响的是精确到元的展示，不是结论方向）。
 */
function sanitizeCost(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

/** 一位小数（路程展示精度；内部用米累加，只在出口处四舍五入） */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 报告状态。口径与 TodayView 一致，且优先尊重行程自己声明的 endDate：
 * - 没有合法 startDate → unknown（算不出周几的日子就不猜，同 weather/ics）；
 * - endDate 合法：today 落在 [startDate, endDate] 内算 ongoing——它是用户
 *   当初填的出行区间，比「天数推算」更权威（两者正常情况一致）；
 * - endDate 缺失（旧数据/只填了天数的请求）：按 startDate + 天数 - 1 推算
 *   末日，走 lib/trip-day 的 tripToday——与行中模式逐字节同一判定逻辑，
 *   不在这里另起一套日期口径。
 */
function computeStatus(
  startDate: string | undefined,
  endDate: string | undefined,
  days: number,
  todayIso: string | undefined,
): TripReportStatus {
  if (!todayIso) return "unknown"; // SSR 首屏不给 today：不猜，等客户端本地时区
  const startMs = isoMs(startDate);
  const todayMs = isoMs(todayIso);
  if (startMs === null || todayMs === null) return "unknown";
  if (todayMs < startMs) return "upcoming";

  const endMs = isoMs(endDate);
  if (endMs !== null) {
    return todayMs > endMs ? "past" : "ongoing";
  }
  const t = tripToday(startDate, todayIso, days);
  switch (t.kind) {
    case "during":
      return "ongoing";
    case "after":
      return "past";
    case "before":
      return "upcoming";
    default:
      return "unknown";
  }
}

/**
 * 汇总一份行程的旅程报告。
 *
 * totalCostCny 取「逐项 costCny 取整后求和」，不直接采信 plan.totalCostCny：
 * 明细才是可解释的出处（旧数据/手工改动过的行程上 plan.totalCostCny 可能
 * 过期），与 lib/budget.ts 同一立场。两者对不上时按逐项合计展示。
 *
 * @param todayIso 调用方按**本地时区**给出的今天 "YYYY-MM-DD"（客户端用
 *                 localTodayIso()）。省略 → status 为 "unknown"。
 */
export function computeTripReport(plan: Plan, todayIso?: string): TripReport {
  const days = Array.isArray(plan?.days) ? plan.days : [];
  const city = typeof plan?.city === "string" && plan.city.trim() ? plan.city.trim() : "行程";

  const seen = new Set<string>();
  const spots: ReportSpot[] = [];
  let sightCount = 0;
  let foodCount = 0;
  let totalCostCny = 0;

  for (const day of days) {
    for (const s of day?.spots ?? []) {
      const name = typeof s?.name === "string" ? s.name.trim() : "";
      if (!name) continue; // 没有名字的条目不算「一个站点」——不猜它是什么
      totalCostCny += sanitizeCost(s?.costCny); // 花费按实际条目计（去过两次 = 两笔）
      if (seen.has(name)) continue; // 同站多天：花费照计、站点只算一次
      seen.add(name);
      const type: string = typeof s?.type === "string" && s.type ? s.type : "other";
      spots.push({ name, type, costCny: sanitizeCost(s?.costCny), day: day.day });
      if (type === "sight") sightCount += 1;
      if (type === "food") foodCount += 1;
    }
  }

  // 路程：逐段 legs 求和。一段有效距离都没有 → undefined（MOCK 模式/旧行程
  // 没有 legs，此时「0 公里」是编造，必须留给组件「不渲染」的判定）。
  let distanceM = 0;
  let distanceLegs = 0;
  let walkM = 0;
  let walkLegs = 0;
  for (const day of days) {
    for (const leg of day?.legs ?? []) {
      const d = leg?.distanceM;
      if (typeof d !== "number" || !Number.isFinite(d) || d < 0) continue;
      distanceM += d;
      distanceLegs += 1;
      if (leg?.mode === "walking") {
        walkM += d;
        walkLegs += 1;
      }
    }
  }

  const startDate = isoMs(plan?.startDate) !== null ? plan.startDate : undefined;
  const endDate = isoMs(plan?.endDate) !== null ? plan.endDate : undefined;

  return {
    city,
    days: days.length,
    ...(startDate !== undefined ? { startDate } : {}),
    ...(endDate !== undefined ? { endDate } : {}),
    status: computeStatus(plan?.startDate, plan?.endDate, days.length, todayIso),
    spotCount: seen.size,
    sightCount,
    foodCount,
    totalCostCny,
    ...(distanceLegs > 0 ? { distanceKm: round1(distanceM / 1000) } : {}),
    ...(walkLegs > 0 ? { walkDistanceKm: round1(walkM / 1000) } : {}),
    spots,
  };
}
