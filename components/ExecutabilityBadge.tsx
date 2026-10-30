"use client";

import type { CSSProperties } from "react";
import { ChevronRight, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { Plan } from "@/lib/types";
import { executabilityOf, formatCheckedAt } from "@/lib/executability";

/**
 * 评分环的语义色档位：A/B 为通过、C 为需微调、D 为走不通。
 * 颜色只从 --at-ok/warn/err 取（见 atlas-evidence.css 的 .exec-ring-*），
 * 组件只决定档位，不写死颜色——主题切换时环会跟着 token 走。
 */
function ringTone(grade: "A" | "B" | "C" | "D"): "ok" | "warn" | "bad" {
  if (grade === "A" || grade === "B") return "ok";
  if (grade === "C") return "warn";
  return "bad";
}

// ============================================================
// 可执行性评分卡：产品差异化的「前台化」
//
// 为什么存在：我们的核验/体检能力原来藏在 warnings、验真徽章、核验报告三处，
// 首屏看不到——用户感知不到「这条行程被验过」。这个组件把 lib/executability.ts
// 的确定性结论做成一个可展开的证据卡：A/B/C/D 分数 + 一句话结论 + 证据链
// （POI 核验数/真实路段/避开闭馆/核验时间）+ 分类问题。
//
// 显示口径（诚实原则）：
// - MOCK：不给分数，明确「未核验」；
// - 生成中：显示「核验中」，不猜进度；
// - 已核验：分数可展开对账（每类问题扣多少分在 lib/executability.ts 有表）。
// ============================================================

export function ExecutabilityBadge({ plan, compact = false }: { plan: Plan; compact?: boolean }) {
  const r = executabilityOf(plan);

  if (r.state === "pending") {
    return (
      <div className="exec-badge exec-pending" data-state="pending">
        <span className="exec-pill">
          <ShieldQuestion size={13} />
          核验中
        </span>
        <span className="exec-summary-text">{r.summary}</span>
      </div>
    );
  }

  const unverified = r.state === "unverified";
  const Icon = unverified ? ShieldAlert : ShieldCheck;
  // 评分环：A–D 四档用语义 token 上色；--at-ring-pct 传给 CSS 的 conic-gradient。
  // 环内是等级字母（分数在 pill 里，避免同一屏出现两个「分数」读数）。
  const tone = r.grade ? ringTone(r.grade) : "warn";
  const ringStyle = {
    "--at-ring-pct": r.score ?? 0,
  } as CSSProperties;

  return (
    <details className={`exec-badge${compact ? " exec-compact" : ""}`} data-state={r.state}>
      <summary className="exec-summary">
        {!unverified && r.score !== null && (
          <span
            className={`exec-ring at-ring exec-ring-${tone}`}
            style={ringStyle}
            aria-hidden="true"
          >
            {r.grade}
          </span>
        )}
        <span className="exec-pill">
          <Icon size={13} />
          {unverified ? "未核验" : `${r.grade} · 可执行性 ${r.score}`}
        </span>

        <span className="exec-summary-text">{r.summary}</span>
        <ChevronRight className="exec-chevron" size={14} aria-hidden="true" />
      </summary>
      <div className="exec-detail">
        <ul className="exec-evidence">
          <li>
            POI 高德核验 <b>{r.verifiedSpots}</b>/<b>{r.totalSpots}</b> 个点位
          </li>
          {r.realLegs > 0 && (
            <li>
              真实路段 <b>{r.realLegs}</b> 段（不是直线距离估算）
            </li>
          )}
          {r.groundedCandidates > 0 && (
            <li>
              生成前已核验候选 <b>{r.groundedCandidates}</b> 个
              {r.closedSkipped > 0 ? `，其中 ${r.closedSkipped} 个含闭馆日已避开` : ""}
            </li>
          )}
          {r.checkedAt ? <li>核验时间 {formatCheckedAt(r.checkedAt)}</li> : null}
        </ul>

        {r.categories.length > 0 && (
          <ul className="exec-issues">
            {r.categories.map((c) => (
              <li key={c.tag}>
                <span className={`exec-tag exec-tag-${c.tag}`}>{c.label}</span>
                <span className="exec-issue-count">{c.count} 条</span>
              </li>
            ))}
          </ul>
        )}

        {unverified ? (
          <p className="exec-hint">
            演示/离线数据不会调用高德：POI 是否存在、营业时间是否合适，请以出发前官方信息为准。
          </p>
        ) : (
          <p className="exec-hint">
            分数按问题类型扣分（时间接不上/营业不符扣得最多），不调模型、可复现；修好一条，分数会跟着变。
          </p>
        )}
      </div>
    </details>
  );
}
