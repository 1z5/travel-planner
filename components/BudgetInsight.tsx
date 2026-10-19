"use client";

// 预算透视卡：预算使用率（进度条 + 语义色）+ 分类构成（堆叠条 + 图例）
// + 一句人话结论。纯展示组件——数据由 summarizeBudget(plan) 在调用方算好传入，
// 本组件不发请求、不读服务端数据，结果页与分享页都能复用。
//
// 为什么金额/百分比不在这里算：口径（取整、最大余数法、阈值）必须只有一处，
// 否则 UI 和图例会各算各的，出现「92% + 9% = 101%」这类肉眼可见的假数据。

import { Wallet } from "lucide-react";
import {
  budgetTone,
  formatCny,
  type BudgetStatus,
  type BudgetSummary,
} from "@/lib/budget";

/** 状态文案：只说事实，不渲染情绪。颜色由 lib 的 budgetTone 统一决定。 */
const STATUS_LABEL: Record<BudgetStatus, string> = {
  unknown: "",
  over: "超出预算",
  tight: "预算偏紧",
  "on-target": "预算达标",
  under: "预算宽松",
};

export function BudgetInsight({ summary }: { summary: BudgetSummary }) {
  const { total, budget, usedPct, categories, notes, status } = summary;
  const tone = budgetTone(status);
  const hasBudget = budget !== undefined && usedPct !== undefined;
  // 超支时进度条填满即可——超出部分靠红色 + 「已用 112%」文案表达；
  // 进度条语义是「预算用了多少」，填 112% 会溢出容器。
  const fillPct = hasBudget ? Math.min(usedPct, 100) : 0;
  // 整数百分比把不足 1% 的类别压成 0%——显示「<1%」比「0%」诚实
  // （金额在图例里仍是真实值，不四舍五入成 0 元）
  const pctText = (pct: number) => (pct === 0 ? "<1%" : `${pct}%`);
  const stackedLabel = categories.map((c) => `${c.label} ${pctText(c.pct)}`).join("，");

  return (
    <section
      className={`budget-insight budget-tone-${tone}`}
      data-status={status}
      aria-label="预算透视"
    >
      <div className="budget-head">
        <span className="budget-title">
          <Wallet size={14} className="budget-title-icon" />
          预算透视
        </span>
        {hasBudget && status !== "unknown" && (
          <span className="budget-status">{STATUS_LABEL[status]}</span>
        )}
      </div>

      {/* budget-usage 始终包一层：两类降级（有/无预算）的顶部间距一致，CSS 只写一处 */}
      <div className="budget-usage">
        {hasBudget ? (
          <>
            <div className="budget-usage-row">
              <span className="budget-usage-text">
                预算 <strong className="budget-usage-strong">{formatCny(budget)}</strong>
                {" · "}已用 <strong className="budget-usage-strong">{formatCny(total)}</strong>
                （{usedPct}%）
              </span>
            </div>
            <div
              className="budget-progress"
              role="progressbar"
              aria-label="预算使用率"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(usedPct, 100)}
              aria-valuetext={`已用预算 ${usedPct}%`}
            >
              {/* 宽度是运行时数据，只能内联；颜色/圆角/过渡交给 CSS（budget-progress-fill） */}
              <div className="budget-progress-fill" style={{ width: `${fillPct}%` }} />
            </div>
          </>
        ) : (
          <div className="budget-usage-row">
            <span className="budget-usage-text">
              人均总花费 <strong className="budget-usage-strong">{formatCny(total)}</strong>
            </span>
          </div>
        )}
      </div>

      {categories.length > 0 && (
        <>
          {/* 堆叠条：每段宽度=该类别占比（整数，和恰好 100%），颜色=类别固定色 */}
          <div className="budget-stack" role="img" aria-label={`花费构成：${stackedLabel}`}>
            {categories.map((c) => (
              <span
                key={c.type}
                className="budget-stack-seg"
                // 宽度/颜色都是运行时数据，只能内联；其余样式交给 CSS
                style={{ width: `${c.pct}%`, background: c.color }}
              />
            ))}
          </div>
          <ul className="budget-legend">
            {categories.map((c) => (
              <li className="budget-legend-item" key={c.type}>
                <span className="budget-swatch" style={{ background: c.color }} aria-hidden="true" />
                <span className="budget-legend-label">{c.label}</span>
                <span className="budget-legend-amount">{formatCny(c.amount)}</span>
                <span className="budget-legend-pct">{pctText(c.pct)}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {categories.length === 0 && !notes[0] && (
        <p className="budget-empty">这份行程暂无花费记录</p>
      )}

      {notes[0] && <p className="budget-conclusion">{notes[0]}</p>}
    </section>
  );
}
