import type { Plan } from "./types";
import { formatCny, summarizeBudget } from "./budget";

// ============================================================
// 竖版海报数据模型（产品线 A5：可保存的分享物料）
//
// 为什么拆成纯函数：海报路由（app/p/[id]/poster）用 next/og 渲染，跑在
// Node runtime 里没法跑组件测试；把「从 Plan 提炼海报内容」这件事抽成
// client-safe 纯函数后，选点规则/预算口径/三态文案都能被单测钉住。
//
// 两条红线：
// 1. **数字与页面同源**：KPI 与预算行全部走 lib/budget.ts 的口径
//    （summarizeBudget/formatCny）——海报和页面说两套话比不说更糟；
//    usedPct 为 undefined（旧数据/无预算）时该 KPI 整个不出现，不猜。
// 2. **三态诚实**：mock/pending 的海报必须显式标注「未经核验」，
//    不许和 ok 状态长得一样——海报是传播物，假数据会被传播得更远。
// ============================================================

export interface PosterKpi {
  label: string;
  value: string;
}

export interface PosterHighlight {
  /** 开始时间（"09:00"），用于海报上的时间列 */
  time: string;
  name: string;
}

export interface PosterModel {
  city: string;
  daysText: string;
  /** "11月9日 → 11月11日"；旧数据没有日期时为 null（不编日期） */
  dateText: string | null;
  kpis: PosterKpi[];
  /** 代表性看点：优先景点/餐饮，跳过住宿/交通占位，最多 4 个 */
  highlights: PosterHighlight[];
  /** "人均 ¥2,002 · 预算使用率 80%"；无预算数据时为 null */
  budgetLine: string | null;
  /** 核验状态一句话（三态，见 buildPosterModel） */
  verifyLine: string;
  brandLine: string;
}

const MAX_HIGHLIGHTS = 4;

/** "YYYY-MM-DD" → "M月D日"（解析不了就原样返回，不猜） */
function fmtCnDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${Number(m[2])}月${Number(m[3])}日`;
}

/** spot.time 形如 "09:00-11:30" → 取开始时间；形状异常时返回空串 */
function startTimeOf(time: string): string {
  const m = time.match(/^(\d{2}:\d{2})/);
  return m ? m[1] : "";
}

/** 核验状态的一句话文案（与页面徽标同口径，但海报上要自包含） */
function verifyLineOf(plan: Plan): string {
  const verification = plan.verification ?? (plan.verified ? "ok" : "mock");
  switch (verification) {
    case "ok":
      return "POI 已通过高德验真";
    case "partial":
      return "部分 POI 未能核验";
    case "pending":
      return "核验进行中";
    default:
      return "演示数据 · 未经核验";
  }
}

export function buildPosterModel(plan: Plan): PosterModel {
  const spots = plan.days.reduce((n, d) => n + d.spots.length, 0);
  const kpis: PosterKpi[] = [
    { label: "天", value: String(plan.days.length) },
    { label: "站", value: String(spots) },
    { label: "人均总花费", value: formatCny(plan.totalCostCny) },
  ];
  // 预算使用率：只有行程记录了预算才算得出来（旧数据/早期分享没有 → 不渲染）
  const budget = summarizeBudget(plan);
  if (budget.usedPct !== undefined) {
    kpis.push({ label: "预算使用率", value: `${budget.usedPct}%` });
  }

  const highlights: PosterHighlight[] = [];
  for (const day of plan.days) {
    for (const spot of day.spots) {
      if (spot.type !== "sight" && spot.type !== "food") continue; // 住宿/交通占位不是「看点」
      if (highlights.length >= MAX_HIGHLIGHTS) break;
      highlights.push({ time: startTimeOf(spot.time), name: spot.name });
    }
    if (highlights.length >= MAX_HIGHLIGHTS) break;
  }

  const dateText =
    plan.startDate && plan.endDate
      ? `${fmtCnDate(plan.startDate)} → ${fmtCnDate(plan.endDate)}`
      : plan.startDate
        ? fmtCnDate(plan.startDate)
        : null;

  return {
    city: plan.city,
    daysText: `${plan.days.length} 天`,
    dateText,
    kpis,
    highlights,
    budgetLine: budgetLine(plan),
    verifyLine: verifyLineOf(plan),
    brandLine: "行程规划师 · 先核验真实世界，再排行程",
  };
}

/** 预算行：与页面预算透视同源；没有预算输入时不给行（不猜使用率） */
function budgetLine(plan: Plan): string | null {
  if (plan.budgetCny === undefined) return null;
  const budget = summarizeBudget(plan);
  const used = budget.usedPct !== undefined ? ` · 预算使用率 ${budget.usedPct}%` : "";
  return `人均 ${formatCny(budget.total)}${used}`;
}
