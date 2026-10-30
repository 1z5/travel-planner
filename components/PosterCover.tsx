"use client";

// 切片1 · 海报级分享页：封面海报区。
//
// 为什么把它做成独立组件而不是塞进 PlanView：PlanView 是「结果页 / 分享页共用」
// 的功能视图（时间轴、体检、预算、编辑入口），而海报只服务于「传播」这一个场景——
// 被分享出去、值得截图。两者生命周期不同（海报不变、PlanView 会随编辑刷新），
// 混在一起会让「加一个传播元素」变成「改核心视图」的高风险动作。
//
// 诚实红线（本组件的设计前提）：
// - 副题与徽章上的每个数字都来自 plan 真实字段（天数 / 站点 / 逐项花费 / 预算使用率）；
// - 拿不到就整块不渲染——没有预算就不出使用率徽章，没有坐标就不出地图块，
//   绝不用默认值填一个「看起来完整」的海报。
// - 地图块只走 RealMap（真实坐标）：MOCK 行程没有坐标，整块不渲染。
//   注意这与 PlanView 的降级策略不同——PlanView 无坐标时降级为 RouteMap 示意图，
//   但海报是「对外传播物」，示意图冒充真实路线是传播层面的失真，宁缺毋滥。

import Link from "next/link";
import { motion } from "framer-motion";
import { CalendarDays, MapPin, Wallet, Route, ArrowRight } from "lucide-react";
import type { Plan } from "@/lib/types";
import { budgetTone, formatCny, summarizeBudget } from "@/lib/budget";
import { parseLocText } from "@/lib/map-view";
import { RealMap } from "./RealMap";
import { CloneCTA } from "./CloneCTA";

export interface PosterCoverProps {
  plan: Plan;
  /** 分享 token（/p/<shareId>）：旅行报告链接与克隆 CTA 都要用它 */
  shareId: string;
}

/** 副题里的主题段最多展示几天：海报副题是「一行」，7 天全列会溢出 */
const MAX_THEMES = 3;

/** RealMap 的站点入参（只取海报用到的三个字段） */
type RoutePoint = { name: string; type: string; location?: string };

/**
 * 站点数：按名称去重。同一家酒店连住 3 天会在 3 个 day 里各出现一次，
 * 按「行程条目数」数会把一个住宿算成三站——「17 站」这种海报数字必须
 * 与「这趟去了哪些地方」的直觉一致（与旅程报告的口径保持同一套）。
 */
function countStops(plan: Plan): number {
  const seen = new Set<string>();
  for (const day of plan.days ?? []) {
    for (const spot of day.spots ?? []) seen.add(spot.name);
  }
  return seen.size;
}

/**
 * 每日主题拼成副题的主题段。截断必须可辨识（补「等」）——
 * 悄悄只显示前 3 天主题会让读的人以为这趟只有这些主题。
 */
function themeSegment(plan: Plan): string {
  const themes = (plan.days ?? [])
    .map((d) => d.theme)
    .filter((t): t is string => typeof t === "string" && t.trim() !== "");
  if (themes.length === 0) return "";
  const head = themes.slice(0, MAX_THEMES).join("、");
  return themes.length > MAX_THEMES ? `${head}等` : head;
}

/**
 * 海报的路线概览只画**首日**动线：多天路线叠在一张静态图上会糊成一片，
 * 而首日是「这趟长什么样」的最佳样本。没有 ≥2 个可解析坐标（MOCK / 未验真）
 * 就返回 null——整块不渲染，不降级成示意图（见文件头说明）。
 */
function firstDayRoute(plan: Plan): { day: Plan["days"][number]; points: RoutePoint[] } | null {
  const day = (plan.days ?? [])[0];
  if (!day) return null;
  const points = (day.spots ?? []).map((s) => ({
    name: s.name,
    type: s.type,
    location: s.location,
  }));
  const located = points.filter((p) => parseLocText(p.location) !== null);
  return located.length >= 2 ? { day, points } : null;
}

/**
 * 封面的「卷首信息行」：日期区间 / 核验状态 / 凭据 / 档案号。
 *
 * 为什么用 mono 行而不是再加徽章：封面主视觉是城市名，任何多出来的大数字都会
 * 抢焦点；刊物封面的信息密度靠「页眉小字」承担。这里只陈述 plan 里已有的状态，
 * 不做推断（缺日期就不印日期，未核验就照实写「未核验」）。
 */
function coverMetaLines(plan: Plan, shareId: string): string[] {
  const lines: string[] = [];
  if (plan.startDate) {
    lines.push(plan.endDate ? `${plan.startDate} → ${plan.endDate}` : `${plan.startDate} 出发`);
  }
  if (plan.verification === "ok") lines.push("POI 已核验");
  else if (plan.verification === "mock") lines.push("MOCK · 未核验");
  else if (plan.verification === "partial") lines.push("部分核验");
  if (plan.tripCheck?.credentialId) lines.push(`凭据 ${plan.tripCheck.credentialId.slice(0, 12)}…`);
  // 档案号取分享 token 尾部：它是这份行程的稳定标识，不是编出来的编号
  const no = shareId.startsWith("share_") ? shareId.slice(6) : shareId;
  if (no) lines.push(`NO. ${no.slice(-6).toUpperCase()}`);
  return lines;
}

/**
 * 分享页顶部海报：城市大标题 + 一行副题 + 数据徽章 + 首日路线 + 底部传播入口。
 * 视觉走「旅行刊物」：衬线大标题、卷首等宽信息行、全出血首日路线图。
 * 入场动画与 PlanView 的卡片同一套节奏，保证整页动效一致。
 */
export function PosterCover({ plan, shareId }: PosterCoverProps) {
  const days = Array.isArray(plan.days) ? plan.days.length : 0;
  const stops = countStops(plan);
  // 花费口径用 lib/budget.ts 的逐项合计（与预算透视同一处实现）：
  // plan.totalCostCny 是回填值、可能过期，明细才是可解释的出处。
  const budget = summarizeBudget(plan);
  const theme = themeSegment(plan);
  const route = firstDayRoute(plan);
  const metaLines = coverMetaLines(plan, shareId);

  // 副题：N 天 · M 站 · 人均 ¥X · 主题（缺的段整段不出现，不留「人均 ¥0」这种假数据）
  const subParts: string[] = [];
  if (days > 0) subParts.push(`${days} 天`);
  if (stops > 0) subParts.push(`${stops} 站`);
  if (budget.total > 0) subParts.push(`人均 ${formatCny(budget.total)}`);
  if (theme) subParts.push(theme);

  return (
    <motion.article
      className="poster"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
    >
      <h1 className="poster-city">{plan.city}</h1>
      {subParts.length > 0 && <p className="poster-sub">{subParts.join(" · ")}</p>}

      {metaLines.length > 0 && (
        <p className="poster-meta at-readout">
          {metaLines.map((line) => (
            <span className="poster-meta-item" key={line}>
              {line}
            </span>
          ))}
        </p>
      )}

      <div className="poster-badges">
        {days > 0 && (
          <div className="poster-badge">
            <CalendarDays size={16} className="poster-badge-icon" />
            <span className="poster-badge-value">{days}</span>
            <span className="poster-badge-label">天</span>
          </div>
        )}
        {stops > 0 && (
          <div className="poster-badge">
            <MapPin size={16} className="poster-badge-icon" />
            <span className="poster-badge-value">{stops}</span>
            <span className="poster-badge-label">站</span>
          </div>
        )}
        {budget.total > 0 && (
          <div className="poster-badge">
            <Wallet size={16} className="poster-badge-icon" />
            <span className="poster-badge-value">{formatCny(budget.total)}</span>
            <span className="poster-badge-label">人均总花费</span>
          </div>
        )}
        {/* 预算使用率徽章：只有行程记录了有效预算（budgetCny）才出现。
            没有预算就不猜使用率——「用掉 NaN%」比没有徽章更糟。 */}
        {budget.usedPct !== undefined && (
          <div className={`poster-badge poster-badge-tone-${budgetTone(budget.status)}`}>
            <Route size={16} className="poster-badge-icon" />
            <span className="poster-badge-value">{budget.usedPct}%</span>
            <span className="poster-badge-label">预算使用率</span>
          </div>
        )}
      </div>

      {route && (
        <div className="poster-map-wrap">
          {/* 真实地图（高德底图 + 自绘覆盖层），与 PlanView 每日地图同一组件 */}
          <RealMap points={route.points} label="海报路线概览" />
          <p className="poster-map-cap">
            首日动线 · 第 {route.day.day} 天「{route.day.theme}」
          </p>
        </div>
      )}

      <div className="poster-foot">
        {/* 一键克隆（切片2）：看到别人行程的人，一键带出「按我的日期重排」的
            版本。克隆走完整生成管线（事实层按新日期重新核验闭馆与通勤）——
            这是与「复制 JSON 改日期」的假克隆的分水岭。 */}
        <CloneCTA plan={plan} shareId={shareId} />
        <Link href={`/r/${shareId}`} className="poster-report-link">
          旅行报告
          <ArrowRight size={14} />
        </Link>
      </div>
    </motion.article>
  );
}
