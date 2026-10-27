"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BedDouble,
  Bike,
  CalendarDays,
  Car,
  Check,
  CloudRain,
  Compass,
  Footprints,
  Landmark,
  Loader2,
  MapPin,
  Navigation,
  Route,
  ShoppingBag,
  TrainFront,
  Utensils,
  Wallet,
  X,
} from "lucide-react";
import type { Plan, PlanDay, PlanLeg, PlanSpot, TransportMode } from "@/lib/types";
import {
  distMeters,
  fmtDist,
  localTodayIso,
  nowMinutes,
  spotNow,
  tripToday,
  type SpotNow,
  type TripToday,
} from "@/lib/trip-day";
import { formatHoursShort } from "@/lib/poi-hours";
import { parseTimeRange } from "@/lib/schedule";
import { TodayExecutionCard, useArrivedSpots } from "./TodayExecutionCard";
// 只 import 类型：replan.ts 本身是 client-safe 纯函数（求解在服务端跑，
// 这里只消费它的返回结构），类型导入不把求解器逻辑打进客户端包。
import type { ReplanResult } from "@/lib/replan";

// ============================================================
// 行中模式（/t/<token>）：旅行当天的「执行视角」。
//
// 与 /p/<token> 的分工：/p 是规划视角（整份行程 + 预算/预警/编辑，供做决策），
// 这里是执行视角（第一屏只有今天：现在在哪、下一站、怎么走、天气如何）。
// 两者数据同源（同一份持久化 Plan），只是信息架构相反——当天站在路口的人
// 不需要知道「第 2 天也许可以加个点」，只需要知道「接下来 30 分钟干什么」。
//
// 外部数据一律「有就用、没有就说没有」：坐标/legs/天气/定位都来自高德或浏览器，
// 任何一项缺失都降级展示原因，绝不编造（不猜、不假装是本项目的产品红线）。
// ============================================================

const TYPE_LABEL: Record<string, string> = {
  sight: "景点",
  food: "餐饮",
  hotel: "住宿",
  transport: "交通",
  shopping: "购物",
  activity: "体验",
};

const TYPE_ICON: Record<string, typeof Landmark> = {
  sight: Landmark,
  food: Utensils,
  hotel: BedDouble,
  transport: TrainFront,
  shopping: ShoppingBag,
  activity: Compass,
};

/** 路段交通方式：与 PlanView 同口径（服务端按用户所选方式算 legs） */
const MODE_LABEL: Record<TransportMode, string> = {
  auto: "智能组合", // 兜底：legs 记的是解析后的具体方式
  walking: "步行",
  bicycling: "骑行",
  driving: "驾车",
};
const MODE_ICON: Record<TransportMode, typeof Footprints> = {
  auto: Footprints,
  walking: Footprints,
  bicycling: Bike,
  driving: Car,
};

/** "2026-10-18" → "10月18日"；缺失/畸形返回空串（日期不随处编） */
function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return "";
  return `${m}月${d}日`;
}

/** 分钟数 → "HH:MM"（重排结果面板里标注「按几点算的」用） */
function fmtClock(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 「导航到这里」：高德 URI（手机浏览器唤起高德 App，桌面打开网页版）。
 * 与 PlanView 同一拼法——同一个点从规划页和行中页点进去必须落到同一个导航目标，
 * 不能两个入口给出两套坐标系/参数。
 */
function amapNavUrl(location: string, name: string): string {
  return (
    `https://uri.amap.com/navigation?to=${location},${encodeURIComponent(name)}` +
    "&mode=car&policy=1&src=travelplanner&coordinate=gaode&callnative=1"
  );
}

/** 坏天气判定（与 lib/weather.ts 同口径；那边 server-only，客户端内联这一条正则） */
function isBadWeatherText(w: string): boolean {
  return /雨|雪|雹|沙|尘|雾|霾/.test(w);
}

/** /api/weather 返回的单日预报（camelCase，见 lib/weather.ts 的 DayWeather） */
interface WeatherDay {
  date: string;
  dayWeather: string;
  nightWeather: string;
  dayTemp: string;
  nightTemp: string;
}

/**
 * 天气三态：idle 未查 / loading 查中 / done 有今天预报 / unavailable 查不到（带原因）。
 * 「查不到」与「有数据」必须分开——把 unavailable 渲染成天气等于编数据。
 */
type WeatherState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; day: WeatherDay }
  | { status: "unavailable"; reason: string };

/** 一键改室内的状态机：idle / loading / done（带新版本号）/ error（带服务端可行动文案） */
type FixState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; revision?: number }
  | { status: "error"; error: string };

/** 定位状态：只有用户主动点击才申请权限；失败给可操作原因，不编距离 */
type LocateState =
  | { status: "idle" }
  | { status: "locating" }
  | { status: "done"; distances: Array<{ location: string; meters: number }> }
  | { status: "error"; reason: string };

/**
 * 行中重规划的状态机：idle 未问 / loading 求解中 / done 有建议 / error（带服务端文案）。
 * 结果只是建议（服务端不落库），所以 done 里不带 revision——没有任何东西被保存。
 */
type ReplanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; result: ReplanResult }
  | { status: "error"; error: string };

/**
 * 两个行程点之间的路段条：方式 + 距离 + 时长 + 可展开的分步指令。
 *
 * 单独拆组件是为了让「legs 缺失/字段畸形」的降级逻辑只写一处：旧行程没有 legs
 * 字段、高德波动时可能只有部分字段，这里能显示多少显示多少，一样都没有就整条不渲染。
 */
function TodayLeg({ leg }: { leg: PlanLeg }) {
  const ModeIcon = MODE_ICON[leg.mode];
  const modeLabel = MODE_LABEL[leg.mode];
  const distance = Number.isFinite(leg.distanceM) ? fmtDist(leg.distanceM) : null;
  const minutes = Number.isFinite(leg.durationSec)
    ? Math.max(1, Math.round(leg.durationSec / 60))
    : null;
  // 人话格式：「步行 500 米 · 7 分钟」（方式与距离用空格，时长前用「·」分隔）
  const head = [modeLabel, distance].filter(Boolean).join(" ");
  const summary =
    minutes !== null ? (head ? `${head} · ${minutes} 分钟` : `${minutes} 分钟`) : head;
  const steps = Array.isArray(leg.steps)
    ? leg.steps.filter((s) => typeof s === "string" && s.trim() !== "")
    : [];
  if (!summary && steps.length === 0) return null;
  return (
    <div className="today-leg">
      {summary && (
        <span className="today-leg-summary">
          {ModeIcon && <ModeIcon size={12} aria-hidden="true" />}
          {summary}
        </span>
      )}
      {steps.length > 0 && (
        <details className="today-leg-steps">
          <summary>分步指令</summary>
          <ol>
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/** 页面底部固定入口：完整行程（规划视角）+ 回首页。三种状态都可用 */
function TodayLinks({ shareId }: { shareId: string }) {
  return (
    <nav className="today-links" aria-label="页面导航">
      <Link className="btn today-link" href={`/p/${shareId}`}>
        查看完整行程
      </Link>
      <Link className="btn today-link today-link-home" href="/">
        我的行程
      </Link>
    </nav>
  );
}

/**
 * 行中今日视图。props 只有两个：
 * - plan     服务端 resolvePlan 读到的完整行程（本组件不自己再拉一次）
 * - shareId  分享 token：底部「查看完整行程」与一键改室内（refine）都用它
 *
 * 组件内部维护本地 viewPlan：一键改室内成功后立刻渲染新版本，不必刷新页面
 * （与 PlanView 的本地视图态同一模式）。
 */
export function TodayView({ plan, shareId }: { plan: Plan; shareId: string }) {
  const [viewPlan, setViewPlan] = useState<Plan>(plan);
  useEffect(() => setViewPlan(plan), [plan]);

  // 时钟：只在客户端挂载后读取。SSR 时服务端时区未必等于用户手机时区，
  // 在服务端算「今天」会让首屏与客户端不一致（hydration 报错），也可能把
  // UTC+8 清晨算成前一天。挂载后立刻算一次，之后每分钟刷新——旅途中页面
  // 可能长开，「现在/下一站」与跨零点都必须跟着走。
  const [clock, setClock] = useState<{ todayIso: string; minutes: number } | null>(null);
  useEffect(() => {
    const tick = () => setClock({ todayIso: localTodayIso(), minutes: nowMinutes() });
    tick();
    const timer = setInterval(tick, 60000);
    return () => clearInterval(timer);
  }, []);

  // 天气 / 一键修复 / 定位：都是用户主动触发，不在加载时打上游接口
  const [weather, setWeather] = useState<WeatherState>({ status: "idle" });
  const [fix, setFix] = useState<FixState>({ status: "idle" });
  const [locate, setLocate] = useState<LocateState>({ status: "idle" });
  // 重规划建议同样只在点击时求解（毫秒级，但也没有「页面一打开就该算」的理由）
  const [replan, setReplan] = useState<ReplanState>({ status: "idle" });

  const days: PlanDay[] = Array.isArray(viewPlan.days) ? viewPlan.days : [];
  const city = typeof viewPlan.city === "string" && viewPlan.city.trim() ? viewPlan.city : "行程";

  const today: TripToday | null = clock
    ? tripToday(viewPlan.startDate, clock.todayIso, days.length)
    : null;
  const currentDay: PlanDay | undefined =
    today?.kind === "during" ? days[today.dayIndex] : undefined;

  // 当天已到达的点位（本地打卡记录，C2）。**必须在任何条件返回之前调用**：
  // hooks 顺序不能随「今天是不是出行日」改变（React Rules of Hooks，踩过）。
  // dayNo 这里用防御式计算（currentDay 可能不存在），与下方 during 分支的
  // dayNo 同源；非出行日读 day 1 的记录也不会有副作用（UI 不展示）。
  const arrivedSpots = useArrivedSpots(shareId, today?.kind === "during" ? today.dayIndex + 1 : 1);

  // 行程被改过（今天换成室内路线）后，之前算出的直线距离可能对应的是旧点位：
  // 清掉定位结果，宁可让用户重新点一次，也不把旧距离贴在新景点上。
  useEffect(() => {
    setLocate({ status: "idle" });
  }, [viewPlan]);

  // 同理：行程被改过后，旧的「接下来怎么走」建议对应的是旧点位/旧时间，
  // 不再可信——清空，让用户按新安排重新问一次（不自动重算：那是猜用户还要不要）。
  useEffect(() => {
    setReplan({ status: "idle" });
  }, [viewPlan]);

  /**
   * 查今天天气：用户主动点击才拉取（行程是出发前按预报排的，当天可能变了）。
   * 只认 /api/weather 的三态：拿不到今天那份预报就明说原因，不猜天气。
   */
  async function checkWeather(): Promise<void> {
    setWeather({ status: "loading" });
    try {
      const r = await fetch(`/api/weather?city=${encodeURIComponent(city)}`);
      const d = await r.json().catch(() => ({}));
      if (d?.state !== "ok" || !Array.isArray(d.days)) {
        setWeather({
          status: "unavailable",
          reason: typeof d?.reason === "string" && d.reason ? d.reason : "暂查不到天气",
        });
        return;
      }
      // 只取「今天」那份预报；超出预报窗口（高德约 4 天）就明说，不自圆其说
      const cast = d.days.find((x: WeatherDay) => x?.date === localTodayIso());
      if (!cast) {
        setWeather({
          status: "unavailable",
          reason: "今天的预报暂未覆盖（高德预报窗口约 4 天）",
        });
        return;
      }
      setWeather({ status: "done", day: cast });
    } catch {
      setWeather({ status: "unavailable", reason: "天气查询失败，请稍后重试" });
    }
  }

  /**
   * 一键「把今天改成室内路线」：走与 PlanView 修改同一条 refine 通道
   * （action=fix, fixKind=rain，服务端用模板化指令重排今天并重体检）。
   * 失败时展示服务端给的可行动文案；请求期间不禁用整页交互，只禁这个按钮。
   */
  async function applyRainFix(): Promise<void> {
    if (!currentDay) return;
    setFix({ status: "loading" });
    try {
      const r = await fetch("/api/plan/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shareId,
          action: "fix",
          fixKind: "rain",
          // 与页头「第 N 天」一致。正常行程 day.day === todayIndex + 1；
          // 用 day.day 而不是下标，是为了兼容非连续编号的历史数据。
          day: currentDay.day,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setFix({
          status: "error",
          error: typeof d?.error === "string" && d.error ? d.error : "改行程失败，请稍后重试",
        });
        return;
      }
      if (!d?.plan) {
        // 契约上成功必带 plan；没拿到就诚实说没改成，不假装成功
        setFix({ status: "error", error: "服务端未返回新行程，当前安排已保留" });
        return;
      }
      setViewPlan(d.plan as Plan);
      setFix({
        status: "done",
        revision: typeof d.revision === "number" ? d.revision : undefined,
      });
    } catch {
      setFix({ status: "error", error: "网络异常，修改未保存，请重试" });
    }
  }

  /**
   * 「离我多远」：一次定位算出今天所有有坐标的点到我的直线距离。
   * 未验真的点没有坐标 → distMeters 返回 null 被过滤，不编距离。
   */
  function locateMe(): void {
    const spots = Array.isArray(currentDay?.spots) ? currentDay.spots : [];
    if (!navigator.geolocation) {
      setLocate({ status: "error", reason: "当前浏览器不支持定位，算不出距离" });
      return;
    }
    setLocate({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const me = `${pos.coords.longitude},${pos.coords.latitude}`;
        const distances = spots
          .map((s) => ({ location: s.location, meters: distMeters(me, s.location) }))
          .filter(
            (x): x is { location: string; meters: number } =>
              typeof x.location === "string" && x.meters !== null,
          )
          .sort((a, b) => a.meters - b.meters);
        setLocate({ status: "done", distances });
      },
      (err) => {
        setLocate({
          status: "error",
          // 1 = PERMISSION_DENIED（GeolocationPositionError 规范）
          reason: err?.code === 1 ? "定位权限被拒绝，可在浏览器设置里开启" : "定位失败，请重试",
        });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }

  /**
   * 「重新安排接下来」：把「今天第几天 + 现在几点（本地时钟）」发给求解器。
   * 服务端只读行程做确定性求解——毫秒级返回、不调模型、不扣配额、不落库。
   * 422（缺真实路段）等失败透传服务端可行动文案；网络异常如实说。
   */
  async function askReplan(): Promise<void> {
    setReplan({ status: "loading" });
    try {
      const r = await fetch("/api/plan/replan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, day: dayNo, nowMin: clock?.minutes ?? 0 }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setReplan({
          status: "error",
          error: typeof d?.error === "string" && d.error ? d.error : "重排失败，请稍后重试",
        });
        return;
      }
      // 契约上 200 必带 kept/dropped；缺字段视为坏响应，诚实说没算出来
      if (!Array.isArray(d?.kept) || !Array.isArray(d?.dropped)) {
        setReplan({ status: "error", error: "服务端返回不完整，建议未生成" });
        return;
      }
      setReplan({
        status: "done",
        result: {
          ok: d.ok !== false,
          kept: d.kept,
          dropped: d.dropped,
          notes: Array.isArray(d.notes) ? d.notes : [],
          ...(typeof d.message === "string" ? { message: d.message } : {}),
        } as ReplanResult,
      });
    } catch {
      setReplan({ status: "error", error: "网络异常，请稍后重试" });
    }
  }

  /** 无日期依据 / 今日数据缺失时的统一降级页：不猜「今天」，只给完整行程入口 */
  function unavailableView() {
    return (
      <div className="today-root">
        <section className="card today-hero">
          <div className="card-body">
            <p className="today-kicker">行中模式</p>
            <h1 className="today-title">{city}</h1>
            <div className="today-status" role="status" aria-live="polite">
              <AlertTriangle size={16} aria-hidden="true" />
              <span className="today-status-text">
                这份行程没有可用的出发日期，判断不了今天是第几天
              </span>
            </div>
            <p className="today-helper">没有日期依据就不猜「今天」；打开完整行程可以看全部安排。</p>
          </div>
        </section>
        <TodayLinks shareId={shareId} />
      </div>
    );
  }

  // ---------- 加载中（还没读到本地时钟）----------
  if (!clock || !today) {
    // 首屏（SSR + hydration 前）只渲染「与时间无关」的骨架：城市、行中模式、
    // 入口链接。不在服务端猜「今天」——服务端时区可能和用户手机不同。
    return (
      <div className="today-root">
        <section className="card today-hero">
          <div className="card-body">
            <p className="today-kicker">行中模式</p>
            <h1 className="today-title">{city}</h1>
            <div className="today-status" role="status" aria-live="polite">
              <Loader2 size={16} className="spin" aria-hidden="true" />
              <span className="today-status-text">正在确认今天…</span>
            </div>
            <p className="today-helper">按你手机的本地时间判断今天是第几天。</p>
          </div>
        </section>
        <TodayLinks shareId={shareId} />
      </div>
    );
  }

  // ---------- 没有可用出发日期：不猜，明确降级 ----------
  if (today.kind === "unknown") return unavailableView();

  // ---------- 出发前：倒计时 + 第一天预览 ----------
  if (today.kind === "before") {
    const firstDay = days[0];
    const firstSpots: PlanSpot[] = Array.isArray(firstDay?.spots) ? firstDay.spots : [];
    return (
      <div className="today-root">
        <section className="card today-hero">
          <div className="card-body">
            <p className="today-kicker">行中模式</p>
            <h1 className="today-title">
              {city} · {days.length} 天行程
            </h1>
            {viewPlan.startDate && <p className="today-sub">{fmtDate(viewPlan.startDate)} 出发</p>}
            <div className="today-status" role="status" aria-live="polite">
              <CalendarDays size={16} aria-hidden="true" />
              <span className="today-status-text">还有 {today.daysUntil} 天出发</span>
            </div>
            <p className="today-helper">出发当天打开这个页面，第一屏只有「今天怎么走」。</p>
          </div>
        </section>

        {firstDay && (
          <section className="card today-preview">
            <div className="card-body">
              <h2 className="today-section-title">第一天预览 · {firstDay.theme}</h2>
              {firstSpots.length > 0 ? (
                <ol className="today-preview-list">
                  {firstSpots.map((s, i) => (
                    <li className="today-preview-item" key={`${s.name}-${i}`}>
                      <span className="today-preview-time">{s.time}</span>
                      <span className="today-preview-name">{s.name}</span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="today-degrade">第一天还没有具体安排。</p>
              )}
            </div>
          </section>
        )}

        <TodayLinks shareId={shareId} />
      </div>
    );
  }

  // ---------- 行程已结束：总结回顾 ----------
  if (today.kind === "after") {
    const spotCount = days.reduce((n, d) => n + (Array.isArray(d.spots) ? d.spots.length : 0), 0);
    const totalCost = typeof viewPlan.totalCostCny === "number" ? viewPlan.totalCostCny : null;
    return (
      <div className="today-root">
        <section className="card today-hero">
          <div className="card-body">
            <p className="today-kicker">行中模式</p>
            <h1 className="today-title">{city}</h1>
            <p className="today-sub">
              {days.length} 天行程
              {viewPlan.startDate
                ? ` · ${fmtDate(viewPlan.startDate)}${
                    viewPlan.endDate ? ` – ${fmtDate(viewPlan.endDate)}` : ""
                  }`
                : ""}
            </p>
            <div className="today-status" role="status" aria-live="polite">
              <CalendarDays size={16} aria-hidden="true" />
              <span className="today-status-text">行程已结束</span>
            </div>
            {viewPlan.summary && <p className="today-summary">{viewPlan.summary}</p>}
            <div className="today-stats">
              <span className="today-stat">
                <CalendarDays size={13} aria-hidden="true" />
                {days.length} 天
              </span>
              <span className="today-stat">
                <MapPin size={13} aria-hidden="true" />
                {spotCount} 个行程点
              </span>
              {totalCost !== null && (
                <span className="today-stat">
                  <Wallet size={13} aria-hidden="true" />
                  人均 ¥{totalCost.toLocaleString()}
                </span>
              )}
            </div>
            <p className="today-helper">这次行程已经走完；想看走过的全部安排，打开完整行程。</p>
          </div>
        </section>
        <TodayLinks shareId={shareId} />
      </div>
    );
  }

  // ============================================================
  // 旅行中（today.kind === "during" 且 currentDay 存在）
  // ============================================================
  // 防御：tripToday 只保证「下标 < 天数」，不保证 days 里真的有这一天
  // （历史/异常数据）。算出来是今天但取不到当天数据时，同样按「不猜」降级。
  if (!currentDay) return unavailableView();

  const spots: PlanSpot[] = Array.isArray(currentDay.spots) ? currentDay.spots : [];
  const legs: PlanLeg[] = Array.isArray(currentDay.legs) ? currentDay.legs : [];
  const spotStatus: SpotNow | null = spotNow(spots, clock.minutes);
  const dayNo = typeof currentDay.day === "number" ? currentDay.day : today.dayIndex + 1;

  const outdoorSpots = spots.filter((s) => s.type === "sight" || s.type === "activity");
  const weatherBad =
    weather.status === "done" &&
    isBadWeatherText(weather.day.dayWeather + weather.day.nightWeather);
  const showFix = weatherBad && outdoorSpots.length > 0 && fix.status !== "done";

  // 现在/下一站/已结束/未开始：每种情况都给一句明确说法（用户站在路口时，
  // 「不知道」比「说错」更糟，但「没有时间可解析」必须诚实说没依据）
  const statusText = (() => {
    if (spots.length === 0) return "今天没有安排行程点";
    if (!spotStatus) return "正在确认现在的位置…";
    if (spotStatus.kind === "now") {
      return `现在：${spots[spotStatus.index]?.name ?? "进行中"}`;
    }
    if (spotStatus.kind === "next") {
      if (spotStatus.index === 0) {
        return `今天的行程还没开始 · 第一站：${spots[0]?.name ?? "待定"}`;
      }
      return `下一站：${spots[spotStatus.index]?.name ?? "待定"}`;
    }
    if (spotStatus.kind === "done") return "今天的行程已结束";
    return "今天的行程点没有可识别的时间，不猜现在在哪";
  })();

  const statusDetail = (() => {
    if (!spotStatus) return null;
    if (spotStatus.kind !== "now" && spotStatus.kind !== "next") return null;
    const s = spots[spotStatus.index];
    if (!s) return null;
    return `${s.time} · ${s.area}`;
  })();

  const weatherAdvice: string | null =
    weather.status !== "done"
      ? null
      : weatherBad
        ? outdoorSpots.length > 0
          ? `今天有 ${outdoorSpots.length} 个室外景点，其中 ${
              outdoorSpots.filter((s) => s.rainBackup).length
            } 个备有雨天备选——天气不佳，建议改成室内路线或参考备选。`
          : "今天天气不佳，但行程以室内/餐饮为主，影响有限。"
        : outdoorSpots.length > 0
          ? `今天天气不错，${outdoorSpots.length} 个室外景点可放心安排。`
          : null;

  const transitText =
    currentDay.transitKnown === false
      ? "通勤未能估算（高德波动）"
      : typeof currentDay.transitMin === "number"
        ? `当天通勤约 ${Math.round(currentDay.transitMin / 6) / 10} 小时`
        : null;
  const dailyCost = typeof currentDay.dailyCostCny === "number" ? currentDay.dailyCostCny : null;

  /** 取某个点位离我的直线距离；没定位/没坐标/坐标非法 → null（不显示，不编） */
  const metersFor = (location: string | undefined): number | null => {
    if (!location || locate.status !== "done") return null;
    return locate.distances.find((x) => x.location === location)?.meters ?? null;
  };

  const hasLocatableSpot = spots.some((s) => typeof s.location === "string" && s.location !== "");

  // 还没走的点（开始时间严格晚于现在）：求解只针对它们——已走过/正在走
  // 的点是既成事实（正在走的点由服务端按「现在的位置」纳入推算）。
  // 时间解析不出的点保守算未来（服务端同口径），不擅自排除。
  const futureSpots: PlanSpot[] = spots.filter((s) => {
    const r = parseTimeRange(s.time);
    return r ? r.start > clock.minutes : true;
  });

  return (
    <div className="today-root">
      {/* ===== 头部：城市 · 第 N 天 + 现在/下一站 ===== */}
      <section className="card today-hero">
        <div className="card-body">
          <p className="today-kicker">行中模式</p>
          <h1 className="today-title">
            {city} · 第 {dayNo} 天
          </h1>
          <p className="today-sub">
            {currentDay.theme || "今日安排"} · {fmtDate(clock.todayIso)}
          </p>
          <div className="today-status today-status-during" role="status" aria-live="polite">
            <span className="today-status-text">{statusText}</span>
          </div>
          {statusDetail && <p className="today-status-detail">{statusDetail}</p>}
        </div>
      </section>

      {/* ===== 天气：用户点击才查；坏天气 + 有室外点 → 一键改室内 ===== */}
      <section className="card today-weather">
        <div className="card-body">
          <h2 className="today-section-title">
            <CloudRain size={16} aria-hidden="true" />
            今天天气
          </h2>

          {weather.status === "idle" && (
            <button
              type="button"
              className="btn today-weather-btn"
              aria-label="查看今天天气"
              onClick={() => void checkWeather()}
            >
              <CloudRain size={14} aria-hidden="true" />
              查看今天天气
            </button>
          )}

          {weather.status === "loading" && (
            <p className="today-helper" role="status">
              <Loader2 size={14} className="spin" aria-hidden="true" />
              天气查询中…
            </p>
          )}

          {weather.status === "unavailable" && (
            <p className="today-degrade" role="status">
              {weather.reason}
            </p>
          )}

          {weather.status === "done" && (
            <>
              <p className="today-weather-line">
                <span>
                  今天白天 {weather.day.dayWeather} · 夜间 {weather.day.nightWeather}
                </span>
                <span className="today-temp">
                  {weather.day.nightTemp}–{weather.day.dayTemp}°C
                </span>
              </p>
              {weatherAdvice && (
                <p className={weatherBad ? "today-weather-warn" : "today-helper"}>
                  {weatherAdvice}
                </p>
              )}

              {showFix && (
                <div className="today-fix">
                  <button
                    type="button"
                    className="btn today-fix-btn"
                    aria-label="把今天改成室内路线"
                    disabled={fix.status === "loading"}
                    onClick={() => void applyRainFix()}
                  >
                    {fix.status === "loading" ? (
                      <>
                        <Loader2 size={14} className="spin" aria-hidden="true" />
                        正在改今天的路线…
                      </>
                    ) : (
                      <>
                        <CloudRain size={14} aria-hidden="true" />
                        把今天改成室内路线
                      </>
                    )}
                  </button>
                  <p className="today-fix-hint">
                    {fix.status === "loading"
                      ? "正在按雨天重排今天，原行程不受影响；失败会保留当前安排。"
                      : "只改今天这一天；生成期间原行程不受影响。"}
                  </p>
                </div>
              )}

              {fix.status === "done" && (
                <p className="today-fix-done" role="status">
                  {typeof fix.revision === "number"
                    ? `已改为第 ${fix.revision} 版`
                    : "今天的路线已更新"}
                </p>
              )}
              {fix.status === "error" && (
                <p className="today-fix-error" role="alert">
                  <AlertTriangle size={14} aria-hidden="true" />
                  {fix.error}
                </p>
              )}
            </>
          )}
        </div>
      </section>

      {/* ===== 离我多远：用户主动定位，一次算出今天各站距离 ===== */}
      {hasLocatableSpot && (
        <section className="card today-locate">
          <div className="card-body">
            <h2 className="today-section-title">
              <MapPin size={16} aria-hidden="true" />
              定位与距离
            </h2>
            <button
              type="button"
              className="btn today-locate-btn"
              aria-label="计算我离今天各站的距离"
              disabled={locate.status === "locating"}
              onClick={locateMe}
            >
              {locate.status === "locating" ? (
                <>
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                  定位中…
                </>
              ) : (
                <>
                  <MapPin size={14} aria-hidden="true" />
                  离我多远
                </>
              )}
            </button>
            {locate.status === "error" && (
              <p className="today-degrade" role="status">
                {locate.reason}
              </p>
            )}
            {locate.status === "done" && locate.distances.length === 0 && (
              <p className="today-degrade" role="status">
                今天的行程点没有可用坐标，算不出距离（未验真的点没有坐标）。
              </p>
            )}
            {locate.status === "done" && locate.distances.length > 0 && (
              <p className="today-helper">
                已算出 {locate.distances.length} 个点的直线距离，显示在时间轴各站下。
              </p>
            )}
          </div>
        </section>
      )}

      {/* ===== 今日时间轴：每个点 + 点之间的真实路段 ===== */}
      <section className="card today-timeline">
        <div className="card-body">
          <h2 className="today-section-title">
            <CalendarDays size={16} aria-hidden="true" />
            今日时间轴
          </h2>

          {spots.length === 0 ? (
            <p className="today-degrade">今天没有安排行程点。</p>
          ) : (
            <ol className="today-spots">
              {spots.map((s, i) => {
                const Icon = TYPE_ICON[s.type] ?? Landmark;
                const mark =
                  spotStatus &&
                  (spotStatus.kind === "now" || spotStatus.kind === "next") &&
                  spotStatus.index === i
                    ? spotStatus.kind
                    : null;
                // 相邻两点之间按 from/to 名称匹配 leg；旧行程没有 legs 字段时为
                // undefined，整条路段卡不渲染（向后兼容，不拿假数据凑）。
                const nextSpot = spots[i + 1];
                const leg = nextSpot
                  ? legs.find((l) => l?.from === s.name && l?.to === nextSpot.name)
                  : undefined;
                const meters = metersFor(s.location);
                return (
                  <li
                    className={`today-spot${mark ? ` today-spot-${mark}` : ""}`}
                    key={`${s.name}-${i}`}
                  >
                    <div className="today-spot-head">
                      <span className="today-spot-time">{s.time}</span>
                      {mark && (
                        <span className={`today-mark-${mark}`}>
                          {mark === "now" ? "现在" : "下一站"}
                        </span>
                      )}
                    </div>

                    <div className="today-spot-name">
                      <span className={`type-badge type-${s.type}`}>
                        <Icon size={11} aria-hidden="true" />
                        {TYPE_LABEL[s.type] ?? s.type}
                      </span>
                      {arrivedSpots.includes(s.name) && (
                        <span className="spot-arrived" title="你标记过已到达">
                          <Check size={12} aria-hidden="true" />
                          已到达
                        </span>
                      )}
                      {s.name}
                    </div>

                    <p className="today-spot-meta">
                      {s.area ? `${s.area} · ` : ""}
                      {typeof s.durationMin === "number"
                        ? `停留 ${s.durationMin} 分钟`
                        : "停留时长未估算"}
                      {typeof s.costCny === "number" ? ` · 人均 ¥${s.costCny}` : ""}
                    </p>

                    {s.poi && (
                      <div className="poi-chips">
                        {s.poi.rating !== undefined && (
                          <span className="poi-chip poi-chip-rating" title="高德真实评分">
                            ★ {s.poi.rating.toFixed(1)}
                          </span>
                        )}
                        {s.poi.temporarilyClosed && (
                          <span className="poi-chip poi-chip-closed" title="高德显示该地点暂停开放">
                            暂停开放
                          </span>
                        )}
                        {(() => {
                          const hoursText = formatHoursShort(s.poi);
                          if (!hoursText) return null;
                          return (
                            <span
                              className="poi-chip"
                              title={s.poi?.openTime2 || s.poi?.openTime || "高德营业时间"}
                            >
                              营业 {hoursText}
                            </span>
                          );
                        })()}
                        {s.type === "food" && s.poi.avgCostCny !== undefined && (
                          <span className="poi-chip" title="高德人均参考价（非本行程预算）">
                            人均参考 ¥{s.poi.avgCostCny}
                          </span>
                        )}
                      </div>
                    )}

                    {s.rainBackup && (
                      <p className="today-spot-backup">
                        <CloudRain size={12} aria-hidden="true" />
                        雨天备选：{s.rainBackup}
                      </p>
                    )}

                    {(s.location || meters !== null) && (
                      <div className="today-spot-actions">
                        {s.location && (
                          <a
                            className="btn-link today-nav-link"
                            href={amapNavUrl(s.location, s.name)}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label={`导航到${s.name}`}
                          >
                            <Navigation size={12} aria-hidden="true" />
                            导航到这里
                          </a>
                        )}
                        {meters !== null && (
                          <span className="today-spot-dist">离我 {fmtDist(meters)}</span>
                        )}
                      </div>
                    )}

                    {leg && <TodayLeg leg={leg} />}
                  </li>
                );
              })}
            </ol>
          )}

          {/* 今日合计：只看今天这一天（行中视角的收口数字） */}
          <p className="today-foot">
            {dailyCost !== null && (
              <span className="today-foot-item">
                <Wallet size={13} aria-hidden="true" />
                今日人均 ¥{dailyCost.toLocaleString()}
              </span>
            )}
            <span className="today-foot-item">
              <MapPin size={13} aria-hidden="true" />
              {spots.length} 个行程点
            </span>
            {transitText && (
              <span className="today-foot-item">
                <TrainFront size={13} aria-hidden="true" />
                {transitText}
              </span>
            )}
          </p>
        </div>
      </section>

      {/* ===== 重新安排接下来：确定性求解的建议面板（不落库） ===== */}
      {/* 只有「今天还有没走的点」才值得问——走完了再问没有意义。
          求解在服务端纯计算完成（毫秒级、不调模型、不扣配额），结果只是
          建议：保留什么、放弃什么、为什么，全部引用真实约束数据。 */}
      {futureSpots.length > 0 && (
        <section className="card replan-card">
          <div className="card-body">
            <h2 className="today-section-title">
              <Route size={16} aria-hidden="true" />
              接下来怎么走
            </h2>
            <p className="today-helper">
              站在路口时按现在的时间重新算一遍：还剩 {futureSpots.length} 个没走的点，
              看看哪些还来得及、哪些要放弃、为什么。
            </p>
            <button
              type="button"
              className="btn replan-btn"
              aria-label="重新安排接下来的行程"
              disabled={replan.status === "loading"}
              onClick={() => void askReplan()}
            >
              {replan.status === "loading" ? (
                <>
                  <Loader2 size={14} className="spin" aria-hidden="true" />
                  正在计算…
                </>
              ) : (
                <>
                  <Route size={14} aria-hidden="true" />
                  重新安排接下来
                </>
              )}
            </button>

            {replan.status === "error" && (
              <p className="replan-error" role="alert">
                <AlertTriangle size={14} aria-hidden="true" />
                {replan.error}
              </p>
            )}

            {replan.status === "done" && (
              <div className="replan-result">
                <p className="today-helper">
                  按 {fmtClock(clock.minutes)} 的现在算的；过一会儿情况变了可以再算一遍。
                </p>

                <h3 className="replan-sub replan-sub-ok">
                  <Check size={13} aria-hidden="true" />
                  保留的点（新时刻）
                </h3>
                {replan.result.kept.length > 0 ? (
                  <ul className="replan-kept">
                    {replan.result.kept.map((k, i) => (
                      <li key={`${k.spot.name}-${i}`}>
                        <span className="replan-time">{k.newTime}</span>
                        <span className="replan-name">{k.spot.name}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="today-degrade">
                    按现在的约束，后面的点一个都保不住——见下面的放弃清单。
                  </p>
                )}

                <h3 className="replan-sub replan-sub-drop">
                  <X size={13} aria-hidden="true" />
                  放弃的点（为什么）
                </h3>
                {replan.result.dropped.length > 0 ? (
                  <ul className="replan-dropped">
                    {replan.result.dropped.map((d, i) => (
                      <li key={`${d.name}-${i}`}>
                        <span className="replan-name">{d.name}</span>
                        <span className="replan-reason">{d.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="today-helper">没有需要放弃的点，后面的安排都还来得及。</p>
                )}

                {replan.result.notes.length > 0 && (
                  <ul className="replan-notes">
                    {replan.result.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}

                {replan.result.message && <p className="today-degrade">{replan.result.message}</p>}

                {/* 显著位置的免责声明：这是建议，没有改行程——采用需要用户主动操作 */}
                <p className="replan-disclaimer">
                  这是建议，未修改你的行程；想采用可对当天「一句话改」（在完整行程页操作）。
                </p>
              </div>
            )}
          </div>
        </section>
      )}

      <TodayLinks shareId={shareId} />
    </div>
  );
}
