"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Check,
  Copy,
  ListChecks,
  Map as MapIcon,
  Navigation,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { Plan } from "@/lib/types";
import { localTodayIso, tripToday, type TripToday } from "@/lib/trip-day";
import { PlanView } from "./PlanView";
import { TodayView } from "./TodayView";
import { RealMap } from "./RealMap";
import { RouteMap } from "./RouteMap";
import { CloneCTA } from "./CloneCTA";
import { DayArrange } from "./DayArrange";
import { ExecutabilityBadge } from "./ExecutabilityBadge";
import { WorkspaceCheck } from "./WorkspaceCheck";
import { track } from "@/lib/track";

// ============================================================
// Trip Workspace：一个行程对象，五个镜头。
//
// 之前「行程 = 一页长文档」：预算、预警、逐天、管家、准备全部平铺，
// 用户要么从头滚到尾，要么去另一个 URL（/t/）看今天。这里把同一份 Plan
// 拆成可切换的镜头：
//   规划（完整内容，含修改/管家）
//   地图（按天看的真实路线 + 当日点位）
//   调整（直接操纵当天点位顺序：拖拽/↑↓ + 确定性重算 + 撤销）
//   今日（行中执行视角）
//   体检（Trip Check：两轴结论 + 规则级证据 + 凭据 + 修复预览/确认写入）
// Trip Header 常驻：城市/天数/日期/核验状态/倒计时 + 复制链接/分享页。
// 出发当天默认落到「今日」镜头——产品自己知道现在该看什么。
// ============================================================

type View = "plan" | "map" | "arrange" | "today" | "check";

const TABS: Array<{ id: View; label: string; icon: typeof ListChecks }> = [
  { id: "plan", label: "规划", icon: ListChecks },
  { id: "map", label: "地图", icon: MapIcon },
  { id: "arrange", label: "调整", icon: SlidersHorizontal },
  { id: "today", label: "今日", icon: Navigation },
  { id: "check", label: "体检", icon: ShieldCheck },
];

const VIEWS: View[] = ["plan", "map", "arrange", "today", "check"];

export function TripWorkspace({ plan: initialPlan, shareId }: { plan: Plan; shareId: string }) {
  const [plan, setPlan] = useState<Plan>(initialPlan);
  useEffect(() => setPlan(initialPlan), [initialPlan]);

  // 深链：/w/<id>?view=map|arrange|today 直接落到某个镜头（分享/书签/通知都用得到）。
  // 显式指定时不执行「出发当天自动进今日」的那套 heuristic——用户明确说了要看什么。
  const params = useSearchParams();
  const requested = params.get("view");
  const explicitView = VIEWS.includes(requested as View) ? (requested as View) : null;
  const [view, setView] = useState<View>(explicitView ?? "plan");
  // 切到「今日」镜头时上报（北极星的分母：行中打开过才知道有没有照着走）
  const trackedToday = useRef(false);
  useEffect(() => {
    if (view !== "today" || trackedToday.current) return;
    trackedToday.current = true;
    track("today_opened", { shareId, city: plan.city });
  }, [view, shareId, plan.city, plan.days]);
  const [dayNo, setDayNo] = useState(1);
  const [today, setToday] = useState<TripToday>({ kind: "unknown" });
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const autoSwitched = useRef(false);

  // 埋点：打开行程（每台设备/每次访问一条；看板按 shareId 去重算漏斗）。
  // 只在客户端跑——SSR 阶段没有「谁打开了」这个信息。
  useEffect(() => {
    track("plan_opened", { shareId, city: initialPlan.city });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只报一次，不随渲染重复
  }, []);

  // 时钟相关状态只在客户端算：SSR 用服务端时区会把「今天」算错，
  // 也会让首屏与客户端不一致。出发当天自动进「今日」镜头（只自动一次，
  // 之后尊重用户的手动切换）。
  useEffect(() => {
    const t = tripToday(plan.startDate, localTodayIso(), plan.days.length);
    setToday(t);
    if (!autoSwitched.current && !explicitView && t.kind === "during") {
      setView("today");
      autoSwitched.current = true;
    }
  }, [plan.startDate, plan.days.length, explicitView]);

  const days = Array.isArray(plan.days) ? plan.days : [];
  const activeDay = days.find((d) => d.day === dayNo) ?? days[0];

  const verify =
    plan.verification === "ok"
      ? { label: "POI 已核验", cls: "ws-badge-ok" }
      : plan.verification === "mock"
        ? { label: "MOCK 模式 · 未核验", cls: "ws-badge-muted" }
        : { label: "核验状态未知", cls: "ws-badge-muted" };

  const statusText =
    today.kind === "before"
      ? `还有 ${today.daysUntil} 天出发`
      : today.kind === "during"
        ? `今天 · 第 ${today.dayIndex + 1} 天`
        : today.kind === "after"
          ? "已结束"
          : "日期未设置";

  async function copyLink() {
    const url = `${window.location.origin}/p/${shareId}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied("idle"), 2400);
  }

  function jumpToDay(n: number) {
    setDayNo(n);
    const el = document.getElementById(`day-${n}`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="trip-workspace">
      <header className="ws-header">
        <div className="ws-header-inner">
          <div className="ws-title">
            <Link href="/" className="ws-back">
              ← 我的行程
            </Link>
            <h1 className="ws-h1">
              {plan.cities?.length
                ? `${plan.cities.map((c) => c.city).join(" → ")} · ${days.length} 天行程`
                : `${plan.city} · ${days.length} 天行程`}
            </h1>
            <p className="ws-meta">
              <span className={`ws-badge ${verify.cls}`}>{verify.label}</span>
              {plan.startDate && plan.endDate ? (
                <span className="ws-meta-item">
                  {plan.startDate} → {plan.endDate}
                </span>
              ) : (
                <span className="ws-meta-item">日期未设置</span>
              )}
              <span className="ws-meta-item">{statusText}</span>
            </p>
            {/* 可执行性评分（紧凑版）：工作台首屏就能看到「这条行程能不能照着走」，
                展开可见证据链；详情区还有完整的体检列表与一键修复，两处口径同源。 */}
            <ExecutabilityBadge plan={plan} compact />
          </div>
          <div className="ws-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyLink()}>
              {copied === "ok" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制链接"}
            </button>
            <Link href={`/p/${shareId}`} className="btn btn-ghost btn-sm">
              分享页
            </Link>
          </div>
        </div>

        <nav className="ws-tabs" role="tablist" aria-label="行程视角">
          <div className="ws-tabs-inner">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = view === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`ws-tab${active ? " ws-tab-active" : ""}`}
                  onClick={() => setView(tab.id)}
                >
                  <Icon size={15} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </nav>
      </header>

      <div className="ws-body">
        {view === "plan" && (
          <>
            {days.length > 1 && (
              <nav className="ws-daynav" aria-label="跳到某一天">
                {days.map((d) => (
                  <button
                    key={d.day}
                    type="button"
                    className={`ws-daychip${d.day === dayNo ? " ws-daychip-active" : ""}`}
                    onClick={() => jumpToDay(d.day)}
                  >
                    Day {d.day}
                    <span>{d.theme}</span>
                  </button>
                ))}
              </nav>
            )}
            <PlanView
              plan={plan}
              shareId={shareId}
              editable
              ownerCheck
              hideCover
              layout="browser"
              activeDay={dayNo}
              onActiveDayChange={setDayNo}
              onPlanChange={setPlan}
            />
            <CloneCTA plan={plan} shareId={shareId} />
          </>
        )}

        {view === "map" && (
          <section className="ws-map" aria-label="行程地图">
            {activeDay ? (
              <>
                <nav className="ws-daynav" aria-label="选择要看的地图日期">
                  {days.map((d) => (
                    <button
                      key={d.day}
                      type="button"
                      className={`ws-daychip${d.day === activeDay.day ? " ws-daychip-active" : ""}`}
                      onClick={() => setDayNo(d.day)}
                    >
                      Day {d.day}
                      <span>{d.city ?? d.theme}</span>
                    </button>
                  ))}
                </nav>
                <div className="card ws-map-card">
                  <RealMap
                    points={activeDay.spots.map((s) => ({
                      name: s.name,
                      type: s.type,
                      location: s.location,
                    }))}
                    label={`第 ${activeDay.day} 天`}
                    fallback={
                      <RouteMap
                        stops={activeDay.spots.map((s) => ({ name: s.name, type: s.type }))}
                      />
                    }
                  />
                  <ol className="ws-spot-list">
                    {activeDay.spots.map((s) => (
                      <li key={`${s.time}-${s.name}`}>
                        <span className="ws-spot-time">{s.time}</span>
                        <span className="ws-spot-name">{s.name}</span>
                        <span className="ws-spot-area">{s.area}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            ) : (
              <div className="card ws-empty-inline">这份行程还没有可展示的天数。</div>
            )}
          </section>
        )}

        {view === "arrange" && (
          <section className="ws-arrange" aria-label="调整行程顺序">
            {activeDay ? (
              <>
                <nav className="ws-daynav" aria-label="选择要调整的日期">
                  {days.map((d) => (
                    <button
                      key={d.day}
                      type="button"
                      className={`ws-daychip${d.day === activeDay.day ? " ws-daychip-active" : ""}`}
                      onClick={() => setDayNo(d.day)}
                    >
                      Day {d.day}
                      <span>{d.theme}</span>
                    </button>
                  ))}
                </nav>
                <DayArrange shareId={shareId} day={activeDay} onPlanChange={setPlan} />
              </>
            ) : (
              <div className="card ws-empty-inline">这份行程还没有可调整的天数。</div>
            )}
          </section>
        )}

        {view === "today" && <TodayView plan={plan} shareId={shareId} />}

        {view === "check" && (
          <section className="ws-check" aria-label="行程体检">
            <WorkspaceCheck plan={plan} shareId={shareId} onPlanChange={setPlan} />
          </section>
        )}
      </div>
    </div>
  );
}
