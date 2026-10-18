"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import {
  Landmark, Utensils, BedDouble, TrainFront, ShoppingBag, Compass,
  Copy, Link2, CalendarDays, AlertTriangle, Lightbulb, MapPin,
} from "lucide-react";
import type { Plan } from "@/lib/types";
import { localTodayIso, nowMinutes, spotNow, tripToday, type SpotNow, type TripToday } from "@/lib/trip-day";
import { cityImage } from "@/lib/city-images";
import { RouteMap } from "./RouteMap";
import { CostChart } from "./CostChart";
import { motion } from "framer-motion";
import { CloudRain } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  sight: "景点", food: "餐饮", hotel: "住宿", transport: "交通",
  shopping: "购物", activity: "体验",
};

const TYPE_ICON: Record<string, typeof Landmark> = {
  sight: Landmark, food: Utensils, hotel: BedDouble, transport: TrainFront,
  shopping: ShoppingBag, activity: Compass,
};

function fmtDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

function toMarkdown(plan: Plan): string {
  const lines: string[] = [`# ${plan.city} ${plan.days.length} 天行程`, "", `> ${plan.summary}`, ""];
  if (plan.startDate) {
    lines.push(`时间：${fmtDate(plan.startDate)}${plan.endDate ? ` – ${fmtDate(plan.endDate)}` : ""}`, "");
  }
  for (const day of plan.days) {
    lines.push(`## Day ${day.day} ${day.theme}`, "");
    for (const s of day.spots) {
      lines.push(`### ${s.time} ${s.name}`);
      lines.push(
        `- ${TYPE_LABEL[s.type] ?? s.type} · ${s.area} · 停留 ${s.durationMin} 分钟 · 人均 ¥${s.costCny}`,
      );
      lines.push(`- ${s.reason}`);
      if (s.rainBackup) lines.push(`- 🌧 雨天备选：${s.rainBackup}`);
      lines.push("");
    }
    const transit = day.transitKnown === false
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

/** 行程展示：结果区与分享页（/p/[id]）共用。 */
export function PlanView({
  plan,
  banner,
  shareId,
}: {
  plan: Plan;
  banner?: ReactNode;
  shareId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // 验真完成度：mock=未接高德 / ok=全部核完 / partial=高德波动导致部分未核。
  // partial 时不能沿用「已通过验真」的说法——那是把没做完的事说成做完了
  const verification = plan.verification ?? (plan.verified ? "ok" : "mock");
  const VERIFY_LABEL: Record<string, string> = {
    mock: "MOCK 模式：未接高德，POI 未验真",
    ok: "✓ POI 已通过高德验真",
    partial: "⚠ 高德服务波动，部分 POI 未能验真",
    pending: "POI 验真进行中…",
  };

  // 「行中」：今天是行程第几天。只在客户端挂载后算——SSR 用服务端的「今天」
  // 会和客户端时区有偏差，避免 hydration 不匹配。首屏渲染 unknown（无高亮），
  // 挂载后补上，对「旅行途中打开」的场景无感。
  const [today, setToday] = useState<TripToday>({ kind: "unknown" });
  const todayRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    setToday(tripToday(plan.startDate, localTodayIso(), plan.days.length));
  }, [plan.startDate, plan.days.length]);
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
    const spots = plan.days[duringIdx].spots;
    const compute = () => setSpotStatus(spotNow(spots, nowMinutes()));
    compute();
    const timer = setInterval(compute, 60000);
    return () => clearInterval(timer);
  }, [duringIdx, plan.days]);

  // 行中状态行文案：今天在哪个位置 +（during 时）现在/下一站。单文本节点，便于测试。
  const tripStatusText = (() => {
    if (today.kind === "before") return `🗓 还有 ${today.daysUntil} 天出发`;
    if (today.kind === "after") return "✓ 行程已结束";
    if (today.kind !== "during") return null;
    const base = `📍 今天 · 第 ${today.dayIndex + 1} 天`;
    if (spotStatus?.kind === "done") return `${base} · 今日行程已结束`;
    if (spotStatus && (spotStatus.kind === "now" || spotStatus.kind === "next")) {
      const spot = plan.days[today.dayIndex].spots[spotStatus.index];
      return `${base} · ${spotStatus.kind === "now" ? "现在" : "下一站"}：${spot.name}`;
    }
    return base;
  })();

  return (
    <>
      {banner}

      {/* ===== 行程头部：城市封面 + 日期/概览/预算 + 导出操作 ===== */}
      <motion.div className="card"
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45 }}>
        <div className="result-cover">
          <img src={cityImage(plan.city)} alt="" />
          <div className="result-cover-veil" />
          <div className="result-cover-text">
            <h2>{plan.city} · {plan.days.length} 天行程</h2>
            {plan.startDate && (
              <div className="result-cover-dates">
                <CalendarDays size={14} />
                {fmtDate(plan.startDate)}
                {plan.endDate ? ` – ${fmtDate(plan.endDate)}` : ""}
                {plan.startAt && plan.endAt ? ` · ${plan.startAt.slice(11)} – ${plan.endAt.slice(11)}` : ""}
              </div>
            )}
          </div>
        </div>

        <div className="card-body">
        <div className="plan-head">
          <span className={`verified-badge ${verification === "ok" ? "live" : verification === "partial" ? "live warn" : "mock"}`}>
            {VERIFY_LABEL[verification]}
          </span>
        </div>

        <p className="plan-summary">{plan.summary}</p>

        <div className="kpi-row">
          <div className="kpi">
            <span className="kpi-value">¥{plan.totalCostCny.toLocaleString()}</span>
            <span className="kpi-label">人均总花费（含当地吃住行玩）</span>
          </div>
          <div className="kpi">
            <span className="kpi-value">{plan.days.length} 天</span>
            <span className="kpi-label">{plan.days.reduce((n, d) => n + d.spots.length, 0)} 个行程点</span>
          </div>
        </div>

        <div className="cost-chart">
          <div className="legend" style={{ marginBottom: 4 }}>每日人均花费</div>
          <CostChart days={plan.days} />
        </div>

        <div className="plan-actions">
          <button type="button" className="btn"
            onClick={async () => {
              await navigator.clipboard.writeText(toMarkdown(plan));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}>
            <Copy size={14} />{copied ? "已复制 Markdown" : "复制 Markdown"}
          </button>
          {shareId && (
            <>
              <button type="button" className="btn"
                onClick={async () => {
                  await navigator.clipboard.writeText(`${location.origin}/p/${shareId}`);
                  setLinkCopied(true);
                  setTimeout(() => setLinkCopied(false), 2000);
                }}>
                <Link2 size={14} />{linkCopied ? "链接已复制" : "复制分享链接"}
              </button>
              <a className="btn" href={`/api/plan/ics?id=${shareId}`}>
                <CalendarDays size={14} />下载日历（.ics）
              </a>
            </>
          )}
        </div>
        </div>
      </motion.div>

      {/* ===== 体检预警 ===== */}
      {plan.warnings.length > 0 && (
        <div className="alert alert-warn">
          <AlertTriangle size={18} style={{ marginTop: 2, flexShrink: 0 }} />
          <div>
            <div className="alert-title">行程体检发现 {plan.warnings.length} 个问题</div>
            <ul>
              {plan.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        </div>
      )}

      {/* ===== 行中状态：今天在哪个位置 + 现在/下一站 ===== */}
      {tripStatusText && (
        <div className={`trip-status trip-status-${today.kind}`}>
          {tripStatusText}
        </div>
      )}

      {/* ===== 分天时间线 ===== */}
      {plan.days.map((day, dayIdx) => {
        const isToday = today.kind === "during" && dayIdx === today.dayIndex;
        return (
          <motion.div className={`card${isToday ? " card-today" : ""}`} key={day.day}
            ref={isToday ? todayRef : undefined}
            initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: Math.min(dayIdx * 0.06, 0.3) }}>
            <div className="day-head">
              <div className="day-num"><small>DAY</small>{day.day}</div>
              {isToday && <span className="today-badge">今天</span>}
              <span className="day-theme">{day.theme}</span>
            </div>

          <div className="route-map-wrap">
            <RouteMap stops={day.spots.map((s) => ({ name: s.name, type: s.type }))} />
          </div>

          <div className="timeline">
            {day.spots.map((s, i) => {
              const Icon = TYPE_ICON[s.type] ?? Landmark;
              // 仅「今天」的卡片标现在/下一站；spotStatus 只在 during 时非空
              const spotMark =
                isToday && spotStatus && (spotStatus.kind === "now" || spotStatus.kind === "next") && i === spotStatus.index
                  ? spotStatus.kind
                  : null;
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
                        <Icon size={11} />{TYPE_LABEL[s.type] ?? s.type}
                      </span>
                      {s.name}
                      {spotMark && (
                        <span className={`spot-${spotMark}-badge`}>
                          {spotMark === "now" ? "现在" : "下一站"}
                        </span>
                      )}
                    </div>
                    <div className="spot-meta">
                      {s.area} · {Math.round(s.durationMin / 60 * 10) / 10} 小时 · 人均 ¥{s.costCny}
                    </div>
                    <div className="spot-reason">{s.reason}</div>
                    {s.rainBackup && (
                      <div className="spot-backup"><CloudRain size={12} />雨天备选：{s.rainBackup}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="day-foot">
            <span>
              {day.transitKnown === false
                ? "当天通勤未能估算（高德服务波动）"
                : `当天通勤约 ${Math.round(day.transitMin / 6) / 10} 小时`}
            </span>
            <span>人均 ¥{day.dailyCostCny.toLocaleString()}</span>
          </p>
        </motion.div>
        );
      })}

      {/* ===== 出行提示 ===== */}
      {plan.tips.length > 0 && (
        <div className="card">
          <h2 style={{ fontSize: 17, margin: "0 0 4px", display: "flex", alignItems: "center", gap: 8 }}>
            <Lightbulb size={16} />出发前提醒
          </h2>
          <ul className="tips">
            {plan.tips.map((t, i) => (
              <li key={i}><Lightbulb size={14} />{t}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
