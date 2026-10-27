import type { TripEventRecord } from "./store/types";

// ============================================================
// 产品指标（度量闭环的纯函数层）。
//
// 为什么单独一层：看板要做的事只有两件——**把事件转成结论**、**在测试里可复现**。
// 这里只接受事件数组、只返回普通对象，不碰 Store、不碰 HTTP，因此
// `GET /api/events/summary` 与单测走的是同一份逻辑。
//
// 隐私口径：事件里只有 shareId / 城市 / 第几天 / 少量布尔 meta，
// **没有手机号、没有 IP、没有行程内容**。看板按聚合值输出，不输出单条事件。
// ============================================================

/** 封闭事件名。新增事件必须加到这里 + 单测，避免脏数据把看板搞糊 */
export const EVENT_NAMES = [
  "plan_created", // 生成完成（服务端记，带 city/days）
  "plan_opened", // 打开行程（工作台或分享页）
  "today_opened", // 打开「今日」镜头（行中）
  "day_modified", // 改了某一天（refine/adjust/reorder，服务端记，带 day/op）
  "trip_cloned", // 克隆了别人的行程
  "today_departed", // 行中：点「我已出发」（前端记，带 day）
  "today_arrived", // 行中：点「我已到达」（前端记，带 day）——「照着走完」的强信号
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

export interface MetricsSummary {
  /** 统计窗口（ms 时间戳） */
  since: number;
  /** 窗口内事件总数 */
  total: number;
  /** 各事件计数 */
  counts: Record<EventName, number>;
  /** 漏斗：生成 → 打开 → 行中打开（每一步的转化与流失） */
  funnel: Array<{ step: EventName; trips: number; conversionFromPrev?: number }>;
  /**
   * 北极星：**照着走完的比例** = 行中打开过、且当天没有被修改的行程占比。
   *
   * 口径（诚实优先）：
   * - 分母只算「行中打开过」的行程——没打开过就不知道有没有照着走，
   *   把它算进分母是在编数据；
   * - 分子 = 这些行程里 **没有任何 day_modified** 的；
   * - 行程按 shareId 归并；未登录用户换设备打开会算成两个 trip（已知局限，
   *   登录体系补齐后可按用户归并）。
   */
  northStar: {
    /** 行中打开过的行程数（分母） */
    tripsWithToday: number;
    /** 其中没有任何 day_modified 的（弱信号：没改过） */
    tripsUnmodified: number;
    /** 其中既没改过、也有「到达」打卡的（强信号：真照着走了） */
    tripsFollowed: number;
    /** 弱信号比例（与旧口径一致，保证历史可比） */
    rate: number | null;
    /** 强信号比例；无到达打卡时为 null（不硬算 0 冒充「都没照着走」） */
    followedRate: number | null;
  };
  /** 改动最多的是第几天（用于发现「行程排得太满」的信号） */
  modifiedByDay: Array<{ day: number; count: number }>;
  /** Top 目的地（按生成数） */
  topCities: Array<{ city: string; created: number }>;
}

const EMPTY_COUNTS = (): Record<EventName, number> =>
  Object.fromEntries(EVENT_NAMES.map((n) => [n, 0])) as Record<EventName, number>;

/** 归一化事件名：不在枚举内的一律忽略（脏数据不进看板） */
function isEventName(name: string): name is EventName {
  return (EVENT_NAMES as readonly string[]).includes(name);
}

export function summarize(events: readonly TripEventRecord[], since: number): MetricsSummary {
  // 过滤 + 收窄类型：filter 的类型守卫不会把数组元素收窄成「name 是 EventName」，
  // 所以这里显式重建（顺带丢掉不在枚举内的脏事件）。
  const clean: Array<TripEventRecord & { name: EventName }> = [];
  for (const e of events) {
    if (isEventName(e.name)) clean.push({ ...e, name: e.name });
  }
  const counts = EMPTY_COUNTS();
  for (const e of clean) counts[e.name] += 1;

  // ---- 漏斗：按 trip（shareId）去重，一步只算一次 ----
  const tripsWith = (name: EventName): Set<string> => {
    const s = new Set<string>();
    for (const e of clean) if (e.name === name && e.shareId) s.add(e.shareId);
    return s;
  };
  const created = tripsWith("plan_created");
  const opened = tripsWith("plan_opened");
  const today = tripsWith("today_opened");
  const steps: EventName[] = ["plan_created", "plan_opened", "today_opened"];
  const sets: Partial<Record<EventName, Set<string>>> = {
    plan_created: created,
    plan_opened: opened,
    today_opened: today,
  };
  let prev: number | undefined;
  const funnel = steps.map((step) => {
    const trips = sets[step]?.size ?? 0;
    const row: MetricsSummary["funnel"][number] = { step, trips };
    if (prev !== undefined && prev > 0) row.conversionFromPrev = trips / prev;
    prev = trips;
    return row;
  });

  // ---- 北极星：行中打开过 & 从未修改（弱信号）/ & 有到达打卡（强信号）----
  // 两个口径分开报：弱信号（没改过）可能与旧版对比，强信号（点了到达）是
  // 「真的照着走」的证据，但依赖用户愿意点一下——没人点时 followedRate 为 null，
  // 不硬算 0 出来冒充「大家都没照着走」。
  const modifiedTrips = new Set<string>();
  for (const e of clean) if (e.name === "day_modified" && e.shareId) modifiedTrips.add(e.shareId);
  const arrivedTrips = new Set<string>();
  for (const e of clean) if (e.name === "today_arrived" && e.shareId) arrivedTrips.add(e.shareId);
  const unmodified = [...today].filter((id) => !modifiedTrips.has(id));
  const followed = unmodified.filter((id) => arrivedTrips.has(id));
  const tripsWithToday = today.size;
  const anyArrival = clean.some((e) => e.name === "today_arrived");
  const northStar: MetricsSummary["northStar"] = {
    tripsWithToday,
    tripsUnmodified: unmodified.length,
    tripsFollowed: followed.length,
    rate: tripsWithToday > 0 ? unmodified.length / tripsWithToday : null,
    followedRate: anyArrival ? followed.length / Math.max(1, tripsWithToday) : null,
  };

  // ---- 改动集中在第几天（发现「排太满」的信号） ----
  const byDay = new Map<number, number>();
  for (const e of clean) {
    if (e.name === "day_modified" && typeof e.day === "number") {
      byDay.set(e.day, (byDay.get(e.day) ?? 0) + 1);
    }
  }
  const modifiedByDay = [...byDay.entries()]
    .map(([day, count]) => ({ day, count }))
    .sort((a, b) => b.count - a.count || a.day - b.day);

  // ---- Top 目的地（按生成数） ----
  const byCity = new Map<string, number>();
  for (const e of clean) {
    if (e.name === "plan_created" && e.city) byCity.set(e.city, (byCity.get(e.city) ?? 0) + 1);
  }
  const topCities = [...byCity.entries()]
    .map(([city, created]) => ({ city, created }))
    .sort((a, b) => b.created - a.created || a.city.localeCompare(b.city))
    .slice(0, 10);

  return { since, total: clean.length, counts, funnel, northStar, modifiedByDay, topCities };
}

/** 生成事件 id（随机 + 时间前缀，避免撞主键） */
export function newEventId(): string {
  return `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
