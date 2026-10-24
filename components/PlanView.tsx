"use client";

import { useMemo, useState, useEffect, useRef, type ReactNode } from "react";
import {
  Landmark,
  Utensils,
  BedDouble,
  TrainFront,
  ShoppingBag,
  Compass,
  Copy,
  Link2,
  CalendarDays,
  AlertTriangle,
  Lightbulb,
  MapPin,
  Wallet,
  RefreshCw,
  Loader2,
  MessageSquareText,
  Printer,
  Navigation,
  X,
  Footprints,
  Bike,
  Car,
  Sparkles,
  TimerReset,
  ShieldCheck,
  ChevronDown,
} from "lucide-react";
import type { Plan, TransportMode } from "@/lib/types";
import {
  localTodayIso,
  nowMinutes,
  spotNow,
  tripToday,
  distMeters,
  fmtDist,
  type SpotNow,
  type TripToday,
} from "@/lib/trip-day";
import { warnTag } from "@/lib/warn-tag";
import { ownsRecentTrip } from "@/lib/recent-trips";
import { RouteMap } from "./RouteMap";
import { PlanCopilot } from "./PlanCopilot";
import type { CopilotSuggestion } from "@/lib/copilot-types";
import { RealMap } from "./RealMap";
import { BudgetInsight } from "./BudgetInsight";
import { CostChart } from "./CostChart";
import { PackingList } from "./PackingList";
import { summarizeBudget } from "@/lib/budget";
import { suggestFix } from "@/lib/fix-actions";
import { isScheduleWarning, isHoursWarning } from "@/lib/schedule";
import { formatHoursShort } from "@/lib/poi-hours";
import { motion } from "framer-motion";
import { CloudRain } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  sight: "景点",
  food: "餐饮",
  hotel: "住宿",
  transport: "交通",
  shopping: "购物",
  activity: "体验",
};

/** 交通方式 → 图标与中文标签（路段卡上显示「步行 496米 · 7分钟」） */
const MODE_ICON: Record<TransportMode, typeof Footprints> = {
  walking: Footprints,
  bicycling: Bike,
  driving: Car,
};
const MODE_LABEL: Record<TransportMode, string> = {
  walking: "步行",
  bicycling: "骑行",
  driving: "驾车",
};

/** 可「换一个」的类型：住宿/交通是行程骨架（服务端会拒绝），不给必失败的入口。
 *  activity 也允许——只有用户指定的重点活动会被服务端按名称拦下并给出明确文案。 */
const SWAPPABLE_TYPES = new Set(["sight", "food", "shopping", "activity"]);

const TYPE_ICON: Record<string, typeof Landmark> = {
  sight: Landmark,
  food: Utensils,
  hotel: BedDouble,
  transport: TrainFront,
  shopping: ShoppingBag,
  activity: Compass,
};

function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

/**
 * 「导航到这里」：高德 URI 导航链接（手机浏览器会唤起高德 App，桌面打开高德网页版）。
 *
 * 为什么用这个而不是自己画导航：定位/路线规划是高德的本职，浏览器地理能力做不了；
 * 而行程里每个验真命中的点都带真实坐标（validate 回填），拼一个链接就能把
 * 「看完行程 → 出发」这一步接上。未验真的点没有坐标，不渲染此入口（不给假地址）。
 */
function amapNavUrl(location: string, name: string): string {
  return (
    `https://uri.amap.com/navigation?to=${location},${encodeURIComponent(name)}` +
    "&mode=car&policy=1&src=travelplanner&coordinate=gaode&callnative=1"
  );
}

function toMarkdown(plan: Plan): string {
  const lines: string[] = [
    `# ${plan.city} ${plan.days.length} 天行程`,
    "",
    `> ${plan.summary}`,
    "",
  ];
  if (plan.startDate) {
    lines.push(
      `时间：${fmtDate(plan.startDate)}${plan.endDate ? ` – ${fmtDate(plan.endDate)}` : ""}`,
      "",
    );
  }
  for (const day of plan.days) {
    lines.push(`## Day ${day.day} ${day.theme}`, "");
    for (const s of day.spots) {
      lines.push(`### ${s.time} ${s.name}`);
      const poiBits: string[] = [];
      if (s.poi?.rating !== undefined) poiBits.push(`评分 ${s.poi.rating.toFixed(1)}`);
      const hoursText = formatHoursShort(s.poi ?? {});
      if (hoursText) poiBits.push(`营业 ${hoursText}`);
      lines.push(
        `- ${TYPE_LABEL[s.type] ?? s.type} · ${s.area} · 停留 ${s.durationMin} 分钟 · 人均 ¥${s.costCny}` +
          (poiBits.length ? ` · ${poiBits.join(" · ")}` : ""),
      );
      lines.push(`- ${s.reason}`);
      if (s.rainBackup) lines.push(`- 🌧 雨天备选：${s.rainBackup}`);
      lines.push("");
    }
    const transit =
      day.transitKnown === false
        ? "通勤未能估算（高德服务波动）"
        : `当天通勤约 ${Math.round((day.transitMin / 60) * 10) / 10} 小时`;
    lines.push(`${transit} · 人均 ¥${day.dailyCostCny}`, "");
  }
  lines.push(`## 预算`, "", `合计人均约 ¥${plan.totalCostCny}`, "");
  if (plan.warnings.length) {
    lines.push("## 体检预警", "", ...plan.warnings.map((w) => `- ⚠️ ${w}`), "");
  }
  if (plan.tips.length) {
    lines.push("## 出发前提醒", "", ...plan.tips.map((t) => `- ${t}`), "");
  }
  return lines.join("\n");
}

/** 行中天气实查状态：idle 未查 / loading 查中 / done 查完（有今天天气或降级原因） */
type WeatherCheck =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "done";
      day?: {
        date: string;
        dayWeather: string;
        nightWeather: string;
        dayTemp: string;
        nightTemp: string;
      };
      reason?: string;
    };

/** 坏天气判定（与 lib/weather.ts 同口径；那边 server-only，客户端内联这一条正则） */
function isBadWeatherText(w: string): boolean {
  return /雨|雪|雹|沙|尘|雾|霾/.test(w);
}

/** 行程修改请求：换一个点 / 重排一天（带一句自然语言指令） */
type RefineRequest =
  | { kind: "swap"; day: number; spotIndex: number }
  | { kind: "day"; day: number; instruction?: string };

/**
 * 行程展示：结果区与分享页（/p/[id]）共用。
 *
 * 三个可选增能（都向后兼容，只读场景不传即无副作用）：
 * - shareId   持久化分享 token：分享链接/日历导出/继续编辑都靠它（Job 只有 2 小时，不能用）
 * - editable  允许修改（调 /api/plan/refine）
 * - ownerCheck 分享页专用：只有本机生成过该行程（localStorage 里有 token）才允许编辑，
 *              防止「把只读链接里的 ?edit=1 改一下」就能改别人的行程
 */
export function PlanView({
  plan,
  banner,
  draftBadge = false,
  shareId,
  editable = false,
  ownerCheck = false,
  hideCover = false,
  onPlanChange,
}: {
  plan: Plan;
  banner?: ReactNode;
  draftBadge?: boolean;
  shareId?: string;
  editable?: boolean;
  ownerCheck?: boolean;
  /** 分享页专用：顶部已有海报封面，PlanView 不再重复渲染文档头 */
  hideCover?: boolean;
  onPlanChange?: (plan: Plan) => void;
}) {
  // 本地视图态：修改行程后立刻渲染新版本，不必回源刷新页面。
  // prop 变更（父组件拿到更新后的 plan / 重新生成）时同步回来。
  const [viewPlan, setViewPlan] = useState<Plan>(plan);
  useEffect(() => setViewPlan(plan), [plan]);

  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // ---- 行程修改（本轮产品跃迁：一次性生成 → 可共编）----
  // busy 键形如 "swap:2:1" / "day:2"：只禁用编辑入口，不阻塞滚动/其它只读交互。
  // 全局串行（任一次修改进行中就禁用所有编辑）——服务端是整份 plan 覆盖写，
  // 并发提交会 last-write-wins 丢掉另一次改动。
  const [busy, setBusy] = useState<string | null>(null);
  const [editError, setEditError] = useState("");
  const [revision, setRevision] = useState<number | null>(null);
  const [editingDay, setEditingDay] = useState<number | null>(null);
  const [instruction, setInstruction] = useState("");
  // 「一键修复」：每类体检问题一个动作。fixBusy 是当前在跑的警告 key（同一时刻只允许一个，
  // 避免两个修复并发互相覆盖——服务端是整份 plan 覆盖写）。
  const [fixBusy, setFixBusy] = useState<string | null>(null);
  const [fixSuccess, setFixSuccess] = useState<{ key: string; text: string } | null>(null);
  // 编辑权限：分享页需要「本机生成过」才放行（localStorage 里认领过这个 token）
  const [editAllowed, setEditAllowed] = useState(!ownerCheck);
  useEffect(() => {
    if (!ownerCheck) {
      setEditAllowed(true);
      return;
    }
    setEditAllowed(!!shareId && ownsRecentTrip(shareId));
  }, [ownerCheck, shareId]);
  const canEdit = editable && !!shareId && editAllowed;

  async function refine(req: RefineRequest): Promise<void> {
    if (!shareId) return;
    const key = req.kind === "swap" ? `swap:${req.day}:${req.spotIndex}` : `day:${req.day}`;
    setBusy(key);
    setEditError("");
    try {
      const r = await fetch("/api/plan/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shareId,
          action: req.kind,
          day: req.day,
          spotIndex: req.kind === "swap" ? req.spotIndex : undefined,
          instruction: req.kind === "day" ? req.instruction : undefined,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 服务端已经给了可行动文案（限流/找不到行程/模型失败），原样展示
        setEditError(d.error || "改行程失败，请稍后重试");
        return;
      }
      if (d.plan) {
        setViewPlan(d.plan);
        onPlanChange?.(d.plan);
      }
      setRevision(typeof d.revision === "number" ? d.revision : null);
      setEditingDay(null);
      setInstruction("");
    } catch {
      setEditError("网络异常，修改未保存，请重试");
    } finally {
      setBusy(null);
    }
  }

  /** 从警告文本里取「第 N 天」（validate / weather 文案统一格式） */
  function warningDay(w: string): number | null {
    const m = w.match(/第\s*(\d+)\s*天/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isInteger(n) && n >= 1 ? n : null;
  }

  /**
   * 一键修复一条体检预警。
   *
   * 两类路径刻意分开：
   * - 时间轴类（「时间接不上」）→ /api/plan/adjust 确定性顺延：不调模型、不扣次数、
   *   毫秒级返回，且结果可预测（按真实路段时长重排）；
   * - 其余可修类 → /api/plan/refine 的 fix 动作：服务端用模板化指令让 AI 改一天，
   *   改完自动重体检。指令不由用户输入，天然没有注入面。
   * 修不了的问题（未验真/境外/系统波动/硬约束）根本没有按钮，不提供假动作。
   */
  async function fixWarning(w: string, key: string): Promise<void> {
    if (!shareId) return;
    setFixBusy(key);
    setEditError("");
    setFixSuccess(null);
    try {
      if (isScheduleWarning(w)) {
        const day = warningDay(w);
        if (day === null) {
          setEditError("这条时间轴预警缺少天数信息，请刷新页面后重试");
          return;
        }
        const r = await fetch("/api/plan/adjust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareId, op: "retime", day }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setEditError(d.error || "顺延时间轴失败，请稍后重试");
          return;
        }
        if (d.plan) {
          setViewPlan(d.plan);
          onPlanChange?.(d.plan);
        }
        setRevision(typeof d.revision === "number" ? d.revision : null);
        setFixSuccess({
          key,
          text: d.changed
            ? `已按真实路段时长顺延第 ${day} 天时间轴（第 ${d.revision} 版）`
            : (Array.isArray(d.notes) && d.notes[0]) || "时间轴已核对，没有需要顺延的地方",
        });
        return;
      }

      const fix = suggestFix(w);
      if (!fix) return;
      // 预算类是全局问题：suggestFix 不给天，服务端会按花费自动选一天；这里只传一个
      // 存在的天（接口要求 day 必须存在）。
      const targetDay = fix.day ?? viewPlan.days[0]?.day ?? 1;
      const r = await fetch("/api/plan/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, action: "fix", fixKind: fix.fixKind, day: targetDay }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setEditError(d.error || "一键修复失败，请稍后重试");
        return;
      }
      if (d.plan) {
        setViewPlan(d.plan);
        onPlanChange?.(d.plan);
      }
      setRevision(typeof d.revision === "number" ? d.revision : null);
      const applied = d.appliedFix?.instruction ? `：${d.appliedFix.instruction}` : "";
      setFixSuccess({
        key,
        text: `已按「${fix.label}」调整（第 ${d.revision} 版）${applied}`,
      });
    } catch {
      setEditError("网络异常，修复未保存，请重试");
    } finally {
      setFixBusy(null);
    }
  }

  /**
   * 执行「行程管家」给的建议——**必须用户点了才执行**（服务端只返回兜底建议，
   * 不会自动改行程）。建议只有两类：确定性顺延（adjust）与一键修复（refine fix），
   * 复用体检查出的同一套接口，因此失败语义/退款/版本号与手动修复完全一致。
   */
  async function applySuggestion(s: CopilotSuggestion): Promise<void> {
    if (!shareId) return;
    setFixBusy("copilot");
    setEditError("");
    setFixSuccess(null);
    try {
      if (s.kind === "retime") {
        const r = await fetch("/api/plan/adjust", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareId, op: "retime", day: s.day }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setEditError(d.error || "顺延时间轴失败，请稍后重试");
          return;
        }
        if (d.plan) {
          setViewPlan(d.plan);
          onPlanChange?.(d.plan);
        }
        setRevision(typeof d.revision === "number" ? d.revision : null);
        setFixSuccess({
          key: "copilot",
          text: d.changed
            ? `已按真实路段时长顺延第 ${s.day} 天时间轴（第 ${d.revision} 版）`
            : (Array.isArray(d.notes) && d.notes[0]) || "时间轴已核对，没有需要顺延的地方",
        });
        return;
      }
      const r = await fetch("/api/plan/refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, action: "fix", fixKind: s.fixKind, day: s.day }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setEditError(d.error || "按建议修改失败，请稍后重试");
        return;
      }
      if (d.plan) {
        setViewPlan(d.plan);
        onPlanChange?.(d.plan);
      }
      setRevision(typeof d.revision === "number" ? d.revision : null);
      const applied = d.appliedFix?.instruction ? `：${d.appliedFix.instruction}` : "";
      setFixSuccess({ key: "copilot", text: `已按建议调整（第 ${d.revision} 版）${applied}` });
    } catch {
      setEditError("网络异常，建议未执行，请重试");
    } finally {
      setFixBusy(null);
    }
  }

  // 验真完成度：mock=未接高德 / ok=全部核完 / partial=高德波动导致部分未核。
  // partial 时不能沿用「已通过验真」的说法——那是把没做完的事说成做完了
  const verification = viewPlan.verification ?? (viewPlan.verified ? "ok" : "mock");
  const VERIFY_LABEL: Record<string, string> = {
    mock: "MOCK 模式：未接高德，POI 未验真",
    ok: "✓ POI 已通过高德验真",
    partial: "⚠ 高德服务波动，部分 POI 未能验真",
    pending: "POI 验真进行中…",
  };

  // 预算透视：分类构成/使用率/人话结论统一由 lib 汇总（口径只在一处），
  // 组件只负责画。改完行程 viewPlan 变化时自动重算。
  const budgetSummary = useMemo(() => summarizeBudget(viewPlan), [viewPlan]);

  // 「行中」：今天是行程第几天。只在客户端挂载后算——SSR 用服务端的「今天」
  // 会和客户端时区有偏差，避免 hydration 不匹配。首屏渲染 unknown（无高亮），
  // 挂载后补上，对「旅行途中打开」的场景无感。
  const [today, setToday] = useState<TripToday>({ kind: "unknown" });
  const todayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setToday(tripToday(viewPlan.startDate, localTodayIso(), viewPlan.days.length));
  }, [viewPlan.startDate, viewPlan.days.length]);
  // 「今天」就绪后自动滚动到当天（依赖 today，等重渲染把 ref 挂上再滚）
  useEffect(() => {
    if (today.kind === "during") {
      todayRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, [today]);

  // 「行中」第二步：今天在行程内时，算「现在在进行哪个点 / 下一站是哪个」。
  // 每分钟刷新——旅途中页面可能长开，一次算完会过期。仅在 during 时跑。
  const duringIdx = today.kind === "during" ? today.dayIndex : -1;
  const [spotStatus, setSpotStatus] = useState<SpotNow | null>(null);
  useEffect(() => {
    if (duringIdx < 0) {
      setSpotStatus(null);
      return;
    }
    const spots = viewPlan.days[duringIdx].spots;
    const compute = () => setSpotStatus(spotNow(spots, nowMinutes()));
    compute();
    const timer = setInterval(compute, 60000);
    return () => clearInterval(timer);
  }, [duringIdx, viewPlan.days]);

  // 行中状态行文案：今天在哪个位置 +（during 时）现在/下一站。单文本节点，便于测试。
  const tripStatusText = (() => {
    if (today.kind === "before") return `🗓 还有 ${today.daysUntil} 天出发`;
    if (today.kind === "after") return "✓ 行程已结束";
    if (today.kind !== "during") return null;
    const base = `📍 今天 · 第 ${today.dayIndex + 1} 天`;
    if (spotStatus?.kind === "done") return `${base} · 今日行程已结束`;
    if (spotStatus && (spotStatus.kind === "now" || spotStatus.kind === "next")) {
      const spot = viewPlan.days[today.dayIndex].spots[spotStatus.index];
      return `${base} · ${spotStatus.kind === "now" ? "现在" : "下一站"}：${spot.name}`;
    }
    return base;
  })();

  // 「行中」第三步：旅途中重查今天天气（行程出发前按预报排，当天可能变了）。
  // 用户主动点击才拉取——不 on-load 打高德。仅 during 时显示入口。
  const [weather, setWeather] = useState<WeatherCheck>({ status: "idle" });
  const todayOutdoorSpots =
    today.kind === "during"
      ? viewPlan.days[today.dayIndex].spots.filter(
          (s) => s.type === "sight" || s.type === "activity",
        )
      : [];
  const checkWeather = async () => {
    setWeather({ status: "loading" });
    try {
      const r = await fetch(`/api/weather?city=${encodeURIComponent(viewPlan.city)}`);
      const d = await r.json();
      if (d.state !== "ok" || !Array.isArray(d.days)) {
        setWeather({ status: "done", reason: d.reason ?? "暂查不到天气" });
        return;
      }
      // 只取「今天」那份预报；超出预报窗口（约 4 天）就明说，不猜
      const cast = d.days.find((x: { date: string }) => x.date === localTodayIso());
      if (!cast) {
        setWeather({ status: "done", reason: "今天的预报暂未覆盖（高德预报窗口约 4 天）" });
        return;
      }
      setWeather({ status: "done", day: cast });
    } catch {
      setWeather({ status: "done", reason: "天气查询失败，请稍后重试" });
    }
  };
  const weatherBad =
    weather.status === "done" && weather.day
      ? isBadWeatherText(weather.day.dayWeather + weather.day.nightWeather)
      : false;
  // 「行中」定位：算我离今天各景点多远。只有带坐标的景点才算（未验真的没坐标，
  // distMeters 返回 null 被过滤）——算不出就少列几个，不编距离。
  const [locate, setLocate] = useState<
    | { status: "idle" }
    | { status: "locating" }
    | { status: "done"; items: Array<{ name: string; meters: number }> }
    | { status: "error"; reason: string }
  >({ status: "idle" });
  const locateMe = () => {
    if (!navigator.geolocation) {
      setLocate({ status: "error", reason: "当前浏览器不支持定位" });
      return;
    }
    setLocate({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const me = `${pos.coords.longitude},${pos.coords.latitude}`;
        const spots = today.kind === "during" ? viewPlan.days[today.dayIndex].spots : [];
        const items = spots
          .map((s) => ({ name: s.name, meters: distMeters(me, s.location) }))
          .filter((x): x is { name: string; meters: number } => x.meters !== null)
          .sort((a, b) => a.meters - b.meters);
        setLocate({ status: "done", items });
      },
      (err) => {
        setLocate({
          status: "error",
          reason:
            err.code === err.PERMISSION_DENIED
              ? "定位权限被拒绝，可在浏览器设置里开启"
              : "定位失败，请重试",
        });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  };
  const weatherAdvice = (() => {
    if (weather.status !== "done" || !weather.day) return null;
    if (weatherBad && todayOutdoorSpots.length > 0) {
      const withBackup = todayOutdoorSpots.filter((s) => s.rainBackup).length;
      return `今天有 ${todayOutdoorSpots.length} 个室外景点，其中 ${withBackup} 个备有雨天备选——天气不佳，建议参考雨天备选或改室内。`;
    }
    if (weatherBad) return "今天天气不佳，但行程以室内/餐饮为主，影响有限。";
    if (todayOutdoorSpots.length > 0)
      return `今天天气不错，可放心安排 ${todayOutdoorSpots.length} 个室外景点。`;
    return null;
  })();

  const submitInstruction = (day: number) => {
    const text = instruction.trim();
    if (!text) return;
    void refine({ kind: "day", day, instruction: text });
  };

  return (
    <>
      {banner}
      {draftBadge && (
        <div className="draft-badge" role="status">
          <span className="draft-badge-icon">⚡</span>
          <span>快速预览 — 精确行程生成中</span>
        </div>
      )}

      {/* ===== 行程头部：城市封面 + 日期/概览/预算 + 导出操作 ===== */}
      <motion.div
        className="card"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}
      >
        {!hideCover && (
          <div className="result-cover">
            <div className="result-cover-text">
              <span className="result-cover-eyebrow">行程 · ITINERARY</span>
              <h2>
                {viewPlan.city} · {viewPlan.days.length} 天行程
              </h2>
              {viewPlan.startDate && (
                <div className="result-cover-dates">
                  <CalendarDays size={14} />
                  {fmtDate(viewPlan.startDate)}
                  {viewPlan.endDate ? ` – ${fmtDate(viewPlan.endDate)}` : ""}
                  {viewPlan.startAt && viewPlan.endAt
                    ? ` · ${viewPlan.startAt.slice(11)} – ${viewPlan.endAt.slice(11)}`
                    : ""}
                </div>
              )}
            </div>
          </div>
        )}

        <div className="card-body">
          <div className="plan-head">
            <span
              className={`verified-badge ${verification === "ok" ? "live" : verification === "partial" ? "live warn" : "mock"}`}
            >
              {VERIFY_LABEL[verification]}
            </span>
            {/* 事实先行徽章：如实告诉用户这份行程是在多少个「高德已核验」候选上排出来的。
                没有事实层（未接高德 / 检索失败）时整块不渲染——不假装用过。 */}
            {viewPlan.grounding && viewPlan.grounding.candidates > 0 && (
              <span
                className="grounding-badge"
                title={
                  viewPlan.grounding.closedSkipped > 0
                    ? `生成前用高德实时数据核验了 ${viewPlan.grounding.candidates} 个候选地点，其中 ${viewPlan.grounding.closedSkipped} 个含闭馆日已提示避开，${viewPlan.grounding.closedOut} 个全程闭馆已剔除`
                    : `生成前用高德实时数据核验了 ${viewPlan.grounding.candidates} 个候选地点（名称、营业时间、评分、人均均已核实）`
                }
              >
                <ShieldCheck size={12} />
                事实先行 · {viewPlan.grounding.candidates} 个已核验候选
                {viewPlan.grounding.closedSkipped > 0 &&
                  ` · 避开 ${viewPlan.grounding.closedSkipped} 个闭馆日`}
              </span>
            )}
            {revision !== null && <span className="rev-badge">已更新 · 第 {revision} 版</span>}
          </div>

          <p className="plan-summary">{viewPlan.summary}</p>

          <div className="kpi-row">
            <div className="kpi">
              <Wallet size={15} className="kpi-icon" />
              <span className="kpi-value">¥{viewPlan.totalCostCny.toLocaleString()}</span>
              <span className="kpi-label">人均总花费</span>
            </div>
            <div className="kpi">
              <CalendarDays size={15} className="kpi-icon" />
              <span className="kpi-value">{viewPlan.days.length} 天</span>
              <span className="kpi-label">行程天数</span>
            </div>
            <div className="kpi">
              <MapPin size={15} className="kpi-icon" />
              <span className="kpi-value">
                {viewPlan.days.reduce((n, d) => n + d.spots.length, 0)} 个
              </span>
              <span className="kpi-label">景点 / 餐点</span>
            </div>
          </div>

          {/* 预算透视：使用率 + 分类构成（「钱花在哪」第一次可见） */}
          <BudgetInsight summary={budgetSummary} />

          <div className="cost-chart">
            <div className="legend" style={{ marginBottom: 4 }}>
              每日人均花费
            </div>
            <CostChart days={viewPlan.days} />
          </div>

          <div className="plan-actions">
            <button
              type="button"
              className="btn"
              onClick={async () => {
                await navigator.clipboard.writeText(toMarkdown(viewPlan));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              <Copy size={14} />
              {copied ? "已复制 Markdown" : "复制 Markdown"}
            </button>
            {shareId && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(`${location.origin}/p/${shareId}`);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  }}
                >
                  <Link2 size={14} />
                  {linkCopied ? "链接已复制" : "复制分享链接"}
                </button>
                <a className="btn" href={`/api/plan/ics?id=${shareId}`}>
                  <CalendarDays size={14} />
                  下载日历（.ics）
                </a>
                <a className="btn btn-today" href={`/t/${shareId}`}>
                  <Footprints size={14} />
                  行中模式
                </a>
              </>
            )}
            <button type="button" className="btn" onClick={() => window.print()}>
              <Printer size={14} />
              打印 / 存 PDF
            </button>
          </div>
          {shareId && (
            <p className="helper plan-share-hint">
              分享链接长期有效（不会随生成任务过期）——对方打开看到的就是当前这一版，你后续的修改会同步进去。
            </p>
          )}
        </div>
      </motion.div>

      {/* ===== 修改失败提示（可行动文案，不吞错）===== */}
      {editError && (
        <div className="alert alert-error" role="alert">
          <AlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
          <span className="edit-error-text">{editError}</span>
          <button
            type="button"
            className="alert-close"
            aria-label="关闭提示"
            onClick={() => setEditError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ===== 体检预警 =====
          浅色杂志风的编辑式「体检」卡：默认收起为一行摘要（标题保留原文案，
          测试依赖），展开是逐条问题 + 一键修复。
          为什么默认收起：11 条预警铺开是一堵黄墙，会把整份行程压垮——但
          「体检而非隐瞒」的红线不能破：摘要行明确写出问题数，详情一键可达。
          少量问题（≤2）时默认展开，避免为了美观藏起关键信息。 */}
      {viewPlan.warnings.length > 0 && (
        <details className="checkup" open={viewPlan.warnings.length <= 2}>
          <summary className="checkup-head">
            <AlertTriangle size={17} className="checkup-icon" />
            <span className="checkup-title">行程体检发现 {viewPlan.warnings.length} 个问题</span>
            <span className="checkup-toggle">展开逐条看</span>
            <ChevronDown size={15} className="checkup-chevron" />
          </summary>
          <ul className="warn-list">
            {viewPlan.warnings.map((w, i) => {
              const tag = warnTag(w);
              const key = `warn:${i}`;
              // 只有「可编辑的持久化行程」才提供修复入口：示例行程（无 shareId）
              // 和别人的只读分享链接（canEdit=false）都不显示按钮，避免点了必失败。
              const fix = canEdit ? suggestFix(w) : null;
              const scheduleFix = canEdit && isScheduleWarning(w);
              const busyThis = fixBusy === key;
              return (
                <li key={i}>
                  {tag && <span className="warn-tag">{tag}</span>}
                  <span className="warn-text">{w}</span>
                  {scheduleFix && (
                    <button
                      type="button"
                      className="warn-fix"
                      disabled={!!fixBusy}
                      onClick={() => void fixWarning(w, key)}
                      title="按真实路段时长重排当天时间轴——不调模型、不扣次数"
                    >
                      {busyThis ? <Loader2 size={12} className="spin" /> : <TimerReset size={12} />}
                      一键顺延
                    </button>
                  )}
                  {!scheduleFix && fix && (
                    <button
                      type="button"
                      className="warn-fix"
                      disabled={!!fixBusy}
                      onClick={() => void fixWarning(w, key)}
                      title={fix.hint}
                    >
                      {busyThis ? <Loader2 size={12} className="spin" /> : <Sparkles size={12} />}
                      {fix.label}
                    </button>
                  )}
                  {fixSuccess?.key === key && (
                    <p className="warn-fixed" role="status">
                      {fixSuccess.text}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}

      {/* ===== 行程管家（step-5）：基于这份行程回答 / 给一个可执行建议 ===== */}
      {shareId && (
        <PlanCopilot
          shareId={shareId}
          onSuggestion={canEdit ? (s) => applySuggestion(s) : undefined}
        />
      )}

      {/* ===== 行中状态：今天在哪个位置 + 现在/下一站 ===== */}
      {tripStatusText && (
        <div className={`trip-status trip-status-${today.kind}`}>{tripStatusText}</div>
      )}

      {/* ===== 行中：重查今天天气（仅旅途中显示，用户主动点击才拉取）===== */}
      {today.kind === "during" && (
        <div className="weather-check">
          {weather.status === "idle" && (
            <button type="button" className="btn" onClick={checkWeather}>
              <CloudRain size={14} />
              查看今天天气
            </button>
          )}
          {weather.status === "loading" && <span className="helper">天气查询中…</span>}
          {weather.status === "done" && weather.day && (
            <div className="weather-now">
              <div className="weather-now-head">
                <CloudRain size={15} />
                <span>
                  今天白天 {weather.day.dayWeather} · 夜间 {weather.day.nightWeather}
                </span>
                <span className="weather-temp">
                  {weather.day.nightTemp}–{weather.day.dayTemp}°C
                </span>
              </div>
              {weatherAdvice && (
                <div className={weatherBad ? "weather-warn" : "helper"}>{weatherAdvice}</div>
              )}
            </div>
          )}
          {weather.status === "done" && !weather.day && weather.reason && (
            <span className="helper">{weather.reason}</span>
          )}
        </div>
      )}

      {/* ===== 行中：定位我在哪（仅旅途中，用户主动点击，算离各景点多远）===== */}
      {today.kind === "during" && (
        <div className="locate-check">
          {(locate.status === "idle" || locate.status === "error") && (
            <button type="button" className="btn" onClick={locateMe}>
              <MapPin size={14} />
              定位我在哪
            </button>
          )}
          {locate.status === "locating" && <span className="helper">定位中…</span>}
          {locate.status === "error" && <span className="helper">{locate.reason}</span>}
          {locate.status === "done" &&
            (locate.items.length === 0 ? (
              <span className="helper">今天的景点都没有坐标，算不出距离（未验真的景点无坐标）</span>
            ) : (
              <div className="locate-now">
                <div className="locate-now-head">
                  <MapPin size={15} />
                  今天各景点离你的距离（近→远）
                </div>
                <ul className="locate-list">
                  {locate.items.slice(0, 6).map((x) => (
                    <li key={x.name} className="locate-nearest-first">
                      {x.name}
                      <span className="locate-dist">{fmtDist(x.meters)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      )}

      {/* ===== 分天时间线 ===== */}
      {viewPlan.days.map((day, dayIdx) => {
        const isToday = today.kind === "during" && dayIdx === today.dayIndex;
        const dayBusy = busy === `day:${day.day}`;
        return (
          <motion.div
            // id 供 Trip Workspace 的「跳到某一天」定位；scroll-margin 见 globals.css
            id={`day-${day.day}`}
            className={`card${isToday ? " card-today" : ""}`}
            key={day.day}
            ref={isToday ? todayRef : undefined}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: Math.min(dayIdx * 0.06, 0.3) }}
          >
            <div className="day-head">
              <div className="day-num">
                <small>DAY</small>
                {day.day}
              </div>
              {isToday && <span className="today-badge">今天</span>}
              {day.city && <span className="today-badge day-city-badge">{day.city}</span>}
              <span className="day-theme">{day.theme}</span>
              {canEdit && (
                <div className="day-tools">
                  <button
                    type="button"
                    className="btn btn-mini"
                    disabled={!!busy}
                    onClick={() => void refine({ kind: "day", day: day.day })}
                    title="按当天主题重排这一天的所有安排"
                  >
                    {dayBusy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                    重排这天
                  </button>
                  <button
                    type="button"
                    className="btn btn-mini"
                    disabled={!!busy}
                    aria-expanded={editingDay === day.day}
                    onClick={() => {
                      setEditError("");
                      setEditingDay(editingDay === day.day ? null : day.day);
                      setInstruction("");
                    }}
                  >
                    <MessageSquareText size={13} />
                    一句话改
                  </button>
                </div>
              )}
            </div>

            {/* 一句话改：自然语言指令只作用于这一天，服务端会重体检并落库 */}
            {canEdit && editingDay === day.day && (
              <div className="day-instruction">
                <input
                  type="text"
                  value={instruction}
                  maxLength={100}
                  aria-label={`第 ${day.day} 天修改指令`}
                  placeholder="例如：这天想轻松点、多安排室内；或把预算压到 600 以内"
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitInstruction(day.day);
                    }
                  }}
                  disabled={dayBusy}
                />
                <button
                  type="button"
                  className="btn"
                  disabled={!instruction.trim() || dayBusy}
                  onClick={() => submitInstruction(day.day)}
                >
                  {dayBusy ? <Loader2 size={13} className="spin" /> : null}改这一天
                </button>
              </div>
            )}

            <div className="route-map-wrap">
              {/* 有坐标（验真命中）→ 真实地图；无坐标（MOCK/未验真）→ 降级到示意图。
                两条路径都在本组件内自处理，PlanView 不需要判断模式。 */}
              <RealMap
                points={day.spots.map((s) => ({
                  name: s.name,
                  type: s.type,
                  location: s.location,
                }))}
                label={`第 ${day.day} 天`}
                fallback={
                  <RouteMap stops={day.spots.map((s) => ({ name: s.name, type: s.type }))} />
                }
              />
            </div>

            <div className="timeline">
              {day.spots.map((s, i) => {
                const Icon = TYPE_ICON[s.type] ?? Landmark;
                // 仅「今天」的卡片标现在/下一站；spotStatus 只在 during 时非空
                const spotMark =
                  isToday &&
                  spotStatus &&
                  (spotStatus.kind === "now" || spotStatus.kind === "next") &&
                  i === spotStatus.index
                    ? spotStatus.kind
                    : null;
                const swapBusy = busy === `swap:${day.day}:${i}`;
                // 到下一站的路段（按用户所选交通方式算）；最后一个点没有下一站。
                // 旧行程无 legs 字段时为 undefined，路段卡整体不渲染（向后兼容）。
                const leg =
                  i < day.spots.length - 1
                    ? day.legs?.find((l) => l.from === s.name && l.to === day.spots[i + 1].name)
                    : undefined;
                const ModeIcon = leg ? MODE_ICON[leg.mode] : null;
                return (
                  <div className={`spot${spotMark ? ` spot-${spotMark}` : ""}`} key={i}>
                    <div className="spot-time">{s.time.replace("-", "\n")}</div>
                    <div className="spot-rail">
                      <div className="spot-dot">
                        <Icon size={14} />
                      </div>
                      {i < day.spots.length - 1 && <div className="spot-line" />}
                    </div>
                    <div>
                      <div className="spot-name">
                        <span className={`type-badge type-${s.type}`}>
                          <Icon size={11} />
                          {TYPE_LABEL[s.type] ?? s.type}
                        </span>
                        {s.name}
                        {spotMark && (
                          <span className={`spot-${spotMark}-badge`}>
                            {spotMark === "now" ? "现在" : "下一站"}
                          </span>
                        )}
                      </div>
                      <div className="spot-meta">
                        {s.area} · {Math.round((s.durationMin / 60) * 10) / 10} 小时 · 人均 ¥
                        {s.costCny}
                      </div>
                      {s.poi && (
                        <div className="poi-chips">
                          {s.poi.rating !== undefined && (
                            <span className="poi-chip poi-chip-rating" title="高德真实评分">
                              ★ {s.poi.rating.toFixed(1)}
                            </span>
                          )}
                          {s.poi.temporarilyClosed && (
                            <span
                              className="poi-chip poi-chip-closed"
                              title="高德显示该地点暂停开放"
                            >
                              暂停开放
                            </span>
                          )}
                          {(() => {
                            const hoursText = formatHoursShort(s.poi);
                            if (!hoursText) return null;
                            // 这一站是否被营业时间体检点名：点名就把 chip 标成警示色，
                            // 让用户在时间轴里也能立刻定位到「可能进不去」的那个点。
                            const flagged = viewPlan.warnings.some(
                              (w) => isHoursWarning(w) && w.includes(s.name),
                            );
                            return (
                              <span
                                className={`poi-chip${flagged ? " poi-chip-warn" : ""}`}
                                title={s.poi?.openTime2 || s.poi?.openTime || "高德营业时间"}
                              >
                                营业 {hoursText}
                              </span>
                            );
                          })()}
                          {s.type === "food" && s.poi.avgCostCny !== undefined && (
                            <span className="poi-chip" title="高德人均参考价（非行程预算）">
                              人均参考 ¥{s.poi.avgCostCny}
                            </span>
                          )}
                          {s.poi.tel && (
                            <a
                              className="poi-chip"
                              href={`tel:${s.poi.tel}`}
                              title={`拨打 ${s.poi.tel}`}
                            >
                              ☎ {s.poi.tel}
                            </a>
                          )}
                        </div>
                      )}
                      <div className="spot-reason">{s.reason}</div>
                      {s.rainBackup && (
                        <div className="spot-backup">
                          <CloudRain size={12} />
                          雨天备选：{s.rainBackup}
                        </div>
                      )}
                      {(canEdit || s.location) && (
                        <div className="spot-actions">
                          {canEdit && SWAPPABLE_TYPES.has(s.type) && (
                            <button
                              type="button"
                              className="btn-link spot-action"
                              disabled={!!busy}
                              onClick={() =>
                                void refine({ kind: "swap", day: day.day, spotIndex: i })
                              }
                              title="保持同一区域与类型，换一个同类去处"
                            >
                              {swapBusy ? (
                                <Loader2 size={12} className="spin" />
                              ) : (
                                <RefreshCw size={12} />
                              )}
                              {swapBusy ? "换台中…" : "换一个"}
                            </button>
                          )}
                          {s.location && (
                            <a
                              className="btn-link spot-action"
                              href={amapNavUrl(s.location, s.name)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <Navigation size={12} />
                              导航到这里
                            </a>
                          )}
                        </div>
                      )}
                      {leg && ModeIcon && (
                        <div className="leg-chip">
                          <ModeIcon size={12} />
                          <span className="leg-summary">
                            {MODE_LABEL[leg.mode]} {fmtDist(leg.distanceM)} · 约
                            {Math.max(1, Math.round(leg.durationSec / 60))}分钟
                          </span>
                          {leg.steps.length > 0 && (
                            <details className="leg-steps">
                              <summary>分步指引</summary>
                              <ol>
                                {leg.steps.map((st, k) => (
                                  <li key={k}>{st}</li>
                                ))}
                              </ol>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="day-foot">
              <span className="day-foot-item">
                <TrainFront size={13} />
                {day.transitKnown === false
                  ? "当天通勤未能估算（高德服务波动）"
                  : `当天通勤约 ${Math.round(day.transitMin / 6) / 10} 小时`}
              </span>
              <span className="day-foot-item">
                <Wallet size={13} />
                人均 ¥{day.dailyCostCny.toLocaleString()}
              </span>
            </p>
          </motion.div>
        );
      })}

      {/* ===== 出行提示 ===== */}
      {viewPlan.tips.length > 0 && (
        <div className="card">
          <h2
            style={{
              fontSize: 17,
              margin: "0 0 4px",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <Lightbulb size={16} />
            出发前提醒
          </h2>
          <ul className="tips">
            {viewPlan.tips.map((t, i) => (
              <li key={i}>
                <Lightbulb size={14} />
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ===== 出发前准备（确定性推导，不调模型；每项带依据与来源） ===== */}
      <PackingList plan={viewPlan} />
    </>
  );
}
