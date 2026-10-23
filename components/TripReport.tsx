"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { CalendarDays, MapPin, Route as RouteIcon, Utensils, Wallet } from "lucide-react";
import { RealMap } from "./RealMap";
import { RouteMap } from "./RouteMap";
import { computeTripReport } from "@/lib/trip-report";
import { localTodayIso } from "@/lib/trip-day";
import { formatCny } from "@/lib/budget";
import type { Plan, PlanDay } from "@/lib/types";

// ============================================================
// 旅程报告（/r/<token>）的海报式报告卡：出行结束后的传播物 + 留存钩子。
//
// 与 PlanView（规划视角）的分工：这里去掉编辑入口、体检预警与管家对话，
// 只留「值得截图」的统计（顶部海报卡 + 餐饮清单 + 路线回顾）。传播链路的
// 逻辑是：收到报告的人 → 想看这趟旅行怎么排的 → 回 /p 或生成自己的行程。
//
// 诚实口径（命门）：
// - 没有行中确认数据就绝不写「你打卡了 X 个点」——本产品没采集 check-in，
//   报告只陈述「行程包含什么」，餐饮清单也只叫「行程餐饮」；
// - 「今天/待出发/进行中」按**用户本地时区**判定：SSR 的服务端时区会猜错
//   日期且 hydration 不匹配，因此首屏（todayIso=undefined）不渲染状态条，
//   客户端挂载后补上——与 TodayView 的 clock 模式逐条一致；
// - 花费为 0 时不渲染花费格：「¥0」分不清免费行程与数据缺失，不猜。
// ============================================================

/** 状态条文案。三种状态都只陈述事实，不编造回忆 */
const STATUS_LABEL: Record<string, string> = {
  past: "这趟旅行已完成",
  ongoing: "旅行进行中",
  upcoming: "待出发",
};

/** "2026-10-18" → "10月18日"；缺失/畸形返回空串（日期不随处编） */
function fmtDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return "";
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return "";
  return `${m}月${d}日`;
}

/** 当天路程（公里，一位小数）：逐段 legs 求和，一段有效距离都没有 → undefined */
function dayDistanceKm(day: PlanDay): number | undefined {
  let meters = 0;
  let legs = 0;
  for (const leg of day?.legs ?? []) {
    const d = leg?.distanceM;
    if (typeof d !== "number" || !Number.isFinite(d) || d < 0) continue;
    meters += d;
    legs += 1;
  }
  return legs > 0 ? Math.round((meters / 1000) * 10) / 10 : undefined;
}

export function TripReport({ plan, shareId }: { plan: Plan; shareId: string }) {
  // 「今天」只按本地时区在客户端取：服务端 UTC 会把清晨算成前一天（见
  // lib/trip-day.ts 的 localTodayIso 注释）。首屏不渲染状态条。
  const [todayIso, setTodayIso] = useState<string | undefined>(undefined);
  useEffect(() => {
    setTodayIso(localTodayIso());
  }, []);

  const report = useMemo(() => computeTripReport(plan, todayIso), [plan, todayIso]);

  const days: PlanDay[] = Array.isArray(plan?.days) ? plan.days : [];
  const summary = typeof plan?.summary === "string" ? plan.summary.trim() : "";
  const foods = report.spots.filter((s) => s.type === "food");

  const dateLabel = report.startDate
    ? report.endDate
      ? `${fmtDate(report.startDate)} – ${fmtDate(report.endDate)}`
      : `${fmtDate(report.startDate)} 出发`
    : undefined;

  // 副题数据行：只拼有数据的部分（缺什么不拼什么），而不是留空占位。
  const metaParts = [
    `${report.days} 天`,
    `行程包含 ${report.spotCount} 站`,
    `${report.sightCount} 个景点`,
    `${report.foodCount} 家餐厅`,
    ...(report.totalCostCny > 0 ? [`人均 ${formatCny(report.totalCostCny)}`] : []),
    ...(dateLabel ? [dateLabel] : []),
  ];

  return (
    <>
      {/* ---------- 海报卡（截图主体）：状态 + 城市 + 大数字网格 ---------- */}
      <article className="report-poster">
        {report.status !== "unknown" && (
          <div className={`report-statusbar report-statusbar-${report.status}`}>
            <span className="report-statusbar-dot" aria-hidden="true" />
            <span className="report-statusbar-label">{STATUS_LABEL[report.status]}</span>
            {dateLabel && <span className="report-statusbar-date">{dateLabel}</span>}
          </div>
        )}

        <span className="report-eyebrow">旅行报告</span>
        <h1 className="report-city">{report.city}</h1>
        {summary && <p className="report-sub">{summary}</p>}
        <p className="report-meta">{metaParts.join(" · ")}</p>

        <div className="report-stats">
          <div className="report-stat">
            <CalendarDays className="report-stat-icon" size={18} aria-hidden="true" />
            <span className="report-stat-value">{report.days}</span>
            <span className="report-stat-label">行程天数</span>
          </div>
          <div className="report-stat">
            <MapPin className="report-stat-icon" size={18} aria-hidden="true" />
            <span className="report-stat-value">{report.spotCount}</span>
            <span className="report-stat-label">行程站点</span>
          </div>
          {/* 花费为 0 不渲染：分不清免费行程与数据缺失，两种解读方向相反 */}
          {report.totalCostCny > 0 && (
            <div className="report-stat">
              <Wallet className="report-stat-icon" size={18} aria-hidden="true" />
              <span className="report-stat-value">{formatCny(report.totalCostCny)}</span>
              <span className="report-stat-label">人均花费</span>
            </div>
          )}
          {/* 没有 legs（MOCK 模式/旧行程）→ 整格不渲染，不写 0 公里 */}
          {report.distanceKm !== undefined && (
            <div className="report-stat">
              <RouteIcon className="report-stat-icon" size={18} aria-hidden="true" />
              <span className="report-stat-value">{report.distanceKm}</span>
              <span className="report-stat-label">总路程（公里）</span>
              {report.walkDistanceKm !== undefined && (
                <span className="report-stat-sub">{`含步行 ${report.walkDistanceKm} 公里`}</span>
              )}
            </div>
          )}
        </div>
      </article>

      {/* ---------- 餐饮清单：只陈述行程安排了哪些餐厅（不是「打卡」——
           没有 check-in 数据就不写回忆叙事）。花费 0 元不显示金额。 ---------- */}
      {foods.length > 0 && (
        <section className="report-section">
          <h2 className="report-section-head">
            <Utensils size={16} aria-hidden="true" />
            行程餐饮
            {/* 单一表达式渲染：React SSR 会在相邻文本子节点之间插入
                <!-- --> 分隔符，模板字符串整体是一个文本节点，输出干净 */}
            <span className="report-section-count">{`${foods.length} 家`}</span>
          </h2>
          <ul className="report-food-list">
            {foods.map((f) => (
              <li className="report-food-item" key={f.name}>
                <span className="report-food-name">{f.name}</span>
                {f.costCny > 0 && <span className="report-food-cost">{formatCny(f.costCny)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- 路线回顾：与 PlanView 同一模式——有坐标（验真命中）→
           真实地图，无坐标（MOCK/未验真）→ RealMap 内部降级为 RouteMap
           示意图，两条路径组件自处理，本组件不判断模式。 ---------- */}
      {days.length > 0 && (
        <section className="report-section">
          <h2 className="report-section-head">
            <RouteIcon size={16} aria-hidden="true" />
            路线回顾
          </h2>
          {days.map((day) => {
            const dayKm = dayDistanceKm(day);
            return (
              <div className="report-route-day" key={day.day}>
                <div className="report-route-day-head">
                  <strong>{`第 ${day.day} 天`}</strong>
                  {typeof day.theme === "string" && day.theme.trim() && (
                    <span className="report-route-theme">{day.theme}</span>
                  )}
                  {dayKm !== undefined && (
                    <span className="report-route-dist">{`路程 ${dayKm} 公里`}</span>
                  )}
                </div>
                <div className="report-day-map">
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
              </div>
            );
          })}
        </section>
      )}

      <nav className="report-cta" aria-label="页面导航">
        <Link className="report-cta-btn" href={`/p/${shareId}`}>
          回到行程
        </Link>
        <Link className="report-cta-btn report-cta-btn-ghost" href="/new">
          规划我的下一趟 →
        </Link>
      </nav>

      {/* 数据边界声明：报告只陈述行程本身。这是传播物的诚实底线——
          看到海报的人不会误以为这些数字来自「实际打卡」。 */}
      <p className="report-footnote">
        本报告只陈述行程本身：景点、餐厅、花费与路程均来自行程数据，不包含行中打卡与消费记录。
      </p>
    </>
  );
}
