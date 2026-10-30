"use client";

import { useEffect, useRef, useState, useTransition, type CSSProperties } from "react";
import { ViewTransition, addTransitionType } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Check,
  Copy,
  ListChecks,
  Map as MapIcon,
  Navigation,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import type { Plan } from "@/lib/types";
import { localTodayIso, tripToday, type TripToday } from "@/lib/trip-day";
import { executabilityOf } from "@/lib/executability";
import { PlanView } from "./PlanView";
import { TodayView } from "./TodayView";
import { RealMap } from "./RealMap";
import { RouteMap } from "./RouteMap";
import { CloneCTA } from "./CloneCTA";
import { DayArrange } from "./DayArrange";
import { DemoReadOnlyNote } from "./DemoReadOnlyNote";
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
//
// ATLAS v6（2026-10）把这一页从「纸面文档」改成「行程指挥台」：
// - 顶栏 HUD：城市/天数/日期/核验状态 + 可执行性评分环（等宽读数）；
// - 五镜头改成滑动的玻璃分段控件：active 指示器是一块可滑动的玻璃，
//   位移由 CSS 变量 --ws-tab-i 驱动（不动 layout，也不逐帧 setState）；
// - 镜头切换包在 React 19.3 <ViewTransition> 里（useTransition +
//   addTransitionType），由 base 层的 .at-lens 交叉淡入；不支持 View
//   Transitions 的浏览器自动退回普通 setState，内容不隐藏。
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

/** 可执行性等级 → 评分环颜色（全部走 token，Light/Nocturne 各自成立） */
const RING_COLOR: Record<string, string> = {
  A: "var(--at-ok)",
  B: "var(--at-teal)",
  C: "var(--at-warn)",
  D: "var(--at-err)",
};

export function TripWorkspace({ plan: initialPlan, shareId }: { plan: Plan; shareId: string }) {
  const [plan, setPlan] = useState<Plan>(initialPlan);
  useEffect(() => setPlan(initialPlan), [initialPlan]);

  // 深链：/w/<id>?view=map|arrange|today 直接落到某个镜头（分享/书签/通知都用得到）。
  // 显式指定时不执行「出发当天自动进今日」的那套 heuristic——用户明确说了要看什么。
  const params = useSearchParams();
  const requested = params.get("view");
  const explicitView = VIEWS.includes(requested as View) ? (requested as View) : null;
  const [view, setView] = useState<View>(explicitView ?? "plan");

  // 镜头切换必须发生在一个 Transition 里，<ViewTransition> 才会真的做动画
  // （普通 setState 不触发）。渲染内容仍在同一棵树里，测试/无 JS 环境按普通
  // state 更新语义工作；不支持 View Transitions 的浏览器只是不播动画。
  const [, startLensTransition] = useTransition();
  function switchView(next: View) {
    if (next === view) return;
    startLensTransition(() => {
      addTransitionType("lens");
      setView(next);
    });
  }

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
  // 演示行程（DEMO_SEED 注入）后端一律 403 拒绝写操作：前端提前降级——
  // Header 徽章 + 全镜头只读提示 + 写入口禁用/隐藏；克隆始终允许（生成新 Plan）。
  const isDemo = plan.demo === true;

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

  // HUD 评分环：与 ExecutabilityBadge / 体检镜头同源（lib/executability.ts），
  // 这里只是把同一份确定性结论做成首屏读数，不另算一套分数。
  const exec = executabilityOf(plan);
  const ringPct = exec.state === "scored" && exec.score !== null ? exec.score : 0;
  const ringColor =
    exec.state === "scored" && exec.grade ? RING_COLOR[exec.grade] : "var(--at-ink-4)";
  const ringValue = exec.state === "scored" && exec.score !== null ? String(exec.score) : "—";
  const ringCaption =
    exec.state === "scored"
      ? `${exec.grade} · ${exec.gradeLabel}`
      : exec.state === "pending"
        ? "核验中"
        : "未核验";
  const tabIndex = Math.max(
    0,
    TABS.findIndex((t) => t.id === view),
  );
  const totalSpots = days.reduce((n, d) => n + d.spots.length, 0);

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
            <div className="ws-hud-strip">
              <Link href="/" className="ws-back">
                <ArrowLeft size={13} aria-hidden="true" />
                我的行程
              </Link>
              {/* 行程编号：仪器铭牌式的「这台机器读哪份数据」，不用完整 token 以免过长 */}
              <span className="ws-hud-id" title={shareId}>
                TRIP ·{" "}
                {shareId
                  .replace(/^share_/, "")
                  .slice(0, 8)
                  .toUpperCase()}
              </span>
              <span className="ws-hud-count">
                {days.length} DAYS / {totalSpots} STOPS
              </span>
            </div>
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
              {isDemo && <span className="ws-badge tc-demo-badge">示例行程 · 只读</span>}
            </p>
            {/* 待修入口：只留「有几处会影响行程 + 去体检」这一个动作。
                ATLAS v6 打磨（2026-10-31）：原来这里还放了一个 compact 版
                ExecutabilityBadge，和右侧评分环、下方体检镜头**三处重复同一个分数**，
                HUD 被撑高 60px。分数留给环（视觉锚点），可执行细节留给体检镜头。 */}
            {exec.state === "scored" && exec.hardIssues > 0 && (
              <button type="button" className="ws-hud-fix" onClick={() => setView("check")}>
                <Wrench size={13} aria-hidden="true" />
                {exec.hardIssues} 处会影响行程 · 去体检修复
              </button>
            )}
          </div>

          <div className="ws-hud-side">
            {/* 评分环：conic-gradient 由 base 层 .at-ring 提供；这里只喂数值与颜色 */}
            <div className="ws-score" data-state={exec.state}>
              <div
                className="at-ring ws-ring"
                style={
                  {
                    "--at-ring-pct": ringPct,
                    "--at-ring-size": "70px",
                    "--at-ring-color": ringColor,
                  } as CSSProperties
                }
                role="img"
                aria-label={`可执行性 ${ringValue === "—" ? "未评分" : `${ringValue} 分`}`}
              >
                <span>{ringValue}</span>
              </div>
              <span className="ws-score-caption">{ringCaption}</span>
            </div>
            <div className="ws-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => void copyLink()}
              >
                {copied === "ok" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制链接"}
              </button>
              <Link href={`/p/${shareId}`} className="btn btn-ghost btn-sm">
                分享页
              </Link>
            </div>
          </div>
        </div>
      </header>

      {/* 镜头条**不在 header 里**：sticky 的生效范围是包含块，放在 header 内
          意味着滚出 HUD 后镜头条会跟着一起消失（用户想切镜头得先滚回顶部）。
          提出来作为 header 的兄弟节点，包含块变成整个 .trip-workspace，
          于是镜头条能一直吸在顶栏药丸下方。 */}
      <nav
        className="ws-tabs"
        role="tablist"
        aria-label="行程视角"
        style={{ "--ws-tab-i": tabIndex } as CSSProperties}
      >
        <div className="ws-tabs-inner">
          {/* 滑动底板：位置由 --ws-tab-i × 自身宽度换算，纯 transform，无重排 */}
          <span className="ws-tab-glider" aria-hidden="true" />
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
                onClick={() => switchView(tab.id)}
              >
                <Icon size={15} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="ws-body">
        {" "}
        {isDemo && <DemoReadOnlyNote plan={plan} shareId={shareId} />}
        {/* 镜头内容：key 变化 + Transition = base 层 .at-lens 的交叉淡入；
            没有 View Transitions 支持时就是一次性替换，不隐藏任何内容。 */}
        <ViewTransition
          key={view}
          name="ws-lens"
          share="at-lens"
          enter="at-lens"
          exit="at-lens"
          default="none"
        >
          <div className={`ws-lens ws-lens-${view}`}>
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
                  editable={!isDemo}
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
                      <div className="ws-map-head">
                        <span className="ws-map-eyebrow">
                          MAP · DAY {String(activeDay.day).padStart(2, "0")}
                        </span>
                        <span className="ws-map-meta">
                          {activeDay.spots.length} 站 · 通勤约{" "}
                          {Math.round(activeDay.transitMin / 6) / 10} 小时 · 人均 ¥
                          {activeDay.dailyCostCny.toLocaleString()}
                        </span>
                      </div>
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
                        {activeDay.spots.map((s, i) => (
                          <li key={`${s.time}-${s.name}`}>
                            <span className="ws-spot-idx" aria-hidden="true">
                              {String(i + 1).padStart(2, "0")}
                            </span>
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
                    <DayArrange
                      shareId={shareId}
                      day={activeDay}
                      onPlanChange={setPlan}
                      readOnly={isDemo}
                    />
                  </>
                ) : (
                  <div className="card ws-empty-inline">这份行程还没有可调整的天数。</div>
                )}
              </section>
            )}

            {view === "today" && (
              // demo 只读：今日重规划/改室内按钮会 403——用 tc-demo-lock 在 CSS 层隐藏
              // （TodayView 不在本任务 scope；组件本身仍渲染只读内容）。
              <div className={isDemo ? "tc-demo-lock" : undefined}>
                <TodayView plan={plan} shareId={shareId} />
              </div>
            )}

            {view === "check" && (
              <section className="ws-check" aria-label="行程体检">
                <div className={isDemo ? "tc-demo-lock" : undefined}>
                  <WorkspaceCheck plan={plan} shareId={shareId} onPlanChange={setPlan} />
                </div>
              </section>
            )}
          </div>
        </ViewTransition>
      </div>
    </div>
  );
}
