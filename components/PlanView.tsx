"use client";

import { useState, type ReactNode } from "react";
import {
  Landmark, Utensils, BedDouble, TrainFront, ShoppingBag, Compass,
  Copy, Link2, CalendarDays, AlertTriangle, Lightbulb, MapPin,
} from "lucide-react";
import type { Plan } from "@/lib/types";

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
    lines.push(`当天通勤约 ${Math.round((day.transitMin / 60) * 10) / 10} 小时 · 人均 ¥${day.dailyCostCny}`, "");
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

  return (
    <>
      {banner}

      {/* ===== 行程头部：城市/日期/概览/预算 + 导出操作 ===== */}
      <div className="card">
        <div className="plan-head">
          <div>
            <h2>{plan.city} · {plan.days.length} 天行程</h2>
            {plan.startDate && (
              <div className="plan-dates">
                <CalendarDays size={14} />
                {fmtDate(plan.startDate)}
                {plan.endDate ? ` – ${fmtDate(plan.endDate)}` : ""}
                {plan.startAt && plan.endAt ? ` · ${plan.startAt.slice(11)} – ${plan.endAt.slice(11)}` : ""}
              </div>
            )}
          </div>
          <span className={`verified-badge ${plan.verified ? "live" : "mock"}`}>
            {plan.verified ? "✓ POI 已通过高德验真" : "MOCK 模式：未接高德，POI 未验真"}
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

      {/* ===== 分天时间线 ===== */}
      {plan.days.map((day) => (
        <div className="card" key={day.day}>
          <div className="day-head">
            <h2><MapPin size={16} />Day {day.day}</h2>
            <span className="day-theme">{day.theme}</span>
          </div>

          <div className="timeline">
            {day.spots.map((s, i) => {
              const Icon = TYPE_ICON[s.type] ?? Landmark;
              return (
                <div className="spot" key={i}>
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
                    </div>
                    <div className="spot-meta">
                      {s.area} · {Math.round(s.durationMin / 60 * 10) / 10} 小时 · 人均 ¥{s.costCny}
                    </div>
                    <div className="spot-reason">{s.reason}</div>
                    {s.rainBackup && (
                      <div className="spot-backup">🌧 雨天备选：{s.rainBackup}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="day-foot">
            <span>
              {plan.verified ? `当天通勤约 ${Math.round(day.transitMin / 6) / 10} 小时` : "MOCK 模式未估算通勤"}
            </span>
            <span>人均 ¥{day.dailyCostCny.toLocaleString()}</span>
          </p>
        </div>
      ))}

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
