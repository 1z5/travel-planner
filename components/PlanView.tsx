"use client";

import { useState, type ReactNode } from "react";
import type { Plan } from "@/lib/types";

const TYPE_LABEL: Record<string, string> = {
  sight: "景点", food: "餐饮", hotel: "住宿", transport: "交通",
  shopping: "购物", activity: "体验",
};

function toMarkdown(plan: Plan): string {
  const lines: string[] = [`# ${plan.city} ${plan.days.length} 天行程`, "", `> ${plan.summary}`, ""];
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
      <div className="card">
        <h2>{plan.city} · {plan.days.length} 天行程</h2>
        <p className="summary-line">{plan.summary}</p>
        <p className="muted">
          合计人均约 ¥{plan.totalCostCny.toLocaleString()}
          {" · "}{plan.verified ? "POI 已通过高德验真" : "MOCK 模式：未接高德，POI 未验真"}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={async () => {
              await navigator.clipboard.writeText(toMarkdown(plan));
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            style={{
              padding: "6px 14px", fontSize: 13, cursor: "pointer",
              border: "1px solid var(--border)", borderRadius: 8, background: "#fff",
            }}
          >
            {copied ? "✅ 已复制 Markdown" : "复制 Markdown"}
          </button>
          {shareId && (
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(`${location.origin}/p/${shareId}`);
                setLinkCopied(true);
                setTimeout(() => setLinkCopied(false), 2000);
              }}
              style={{
                padding: "6px 14px", fontSize: 13, cursor: "pointer",
                border: "1px solid var(--border)", borderRadius: 8, background: "#fff",
              }}
            >
              {linkCopied ? "✅ 链接已复制" : "复制分享链接"}
            </button>
          )}
        </div>
      </div>

      {plan.warnings.length > 0 && (
        <div className="warnings">
          <div className="wtitle">⚠️ 行程体检发现 {plan.warnings.length} 个问题</div>
          <ul>{plan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      )}

      {plan.days.map((day) => (
        <div className="card" key={day.day}>
          <div className="day-header">
            <h2>Day {day.day}</h2>
            <span className="theme">{day.theme}</span>
          </div>
          {day.spots.map((s, i) => (
            <div className="spot" key={i}>
              <div className="time">{s.time}</div>
              <div className="body">
                <div className="name">
                  <span className="badge">{TYPE_LABEL[s.type] ?? s.type}</span>
                  {s.name}
                  <span className="meta"> · {s.area} · {Math.round(s.durationMin / 60 * 10) / 10}h · ¥{s.costCny}</span>
                </div>
                <div className="reason">{s.reason}</div>
                {s.rainBackup && <div className="backup">🌧 雨天备选：{s.rainBackup}</div>}
              </div>
            </div>
          ))}
          <p className="muted" style={{ marginBottom: 0 }}>
            {plan.verified
              ? `当天通勤约 ${Math.round(day.transitMin / 6) / 10}h · `
              : "MOCK 模式未估算通勤 · "}
            人均 ¥{day.dailyCostCny.toLocaleString()}
          </p>
        </div>
      ))}

      {plan.tips.length > 0 && (
        <div className="card">
          <h2>出发前提醒</h2>
          <ul>{plan.tips.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </div>
      )}
    </>
  );
}
