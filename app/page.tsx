"use client";

import { useEffect, useState } from "react";
import type { Plan } from "@/lib/types";

const PREF_OPTIONS = [
  "美食", "历史文化", "自然风光", "Citywalk", "博物馆",
  "购物", "拍照打卡", "小众冷门", "亲子友好", "夜生活",
];

const TYPE_LABEL: Record<string, string> = {
  sight: "景点", food: "餐饮", hotel: "住宿", transport: "交通",
  shopping: "购物", activity: "体验",
};

// 等待期的阶段提示（对应真实处理流程：生成 → 展开 → 验真 → 体检）
const WAITING_TIPS = [
  "推理模型正在推演预算、动线与节奏约束…",
  "正在展开每天的时刻表（POI / 时长 / 雨天备选）…",
  "即将核查 POI 真实性与站点间通勤…",
  "最后跑一遍体检：绕路、节奏、预算…",
];

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

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

export default function Home() {
  const [city, setCity] = useState("成都");
  const [days, setDays] = useState(4);
  const [budget, setBudget] = useState(3000);
  const [prefs, setPrefs] = useState<string[]>(["美食", "历史文化"]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);

  // 等待期间的秒表
  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [loading]);

  // 等待期间的阶段提示轮换
  useEffect(() => {
    if (!loading) return;
    setTipIndex(0);
    const t = setInterval(() => setTipIndex((i) => (i + 1) % WAITING_TIPS.length), 4500);
    return () => clearInterval(t);
  }, [loading]);

  function togglePref(p: string) {
    setPrefs((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  async function pollJob(jobId: string): Promise<void> {
    const poll = async (): Promise<void> => {
      const res = await fetch(`/api/plan/status?id=${jobId}`);
      const data = await res.json();
      if (data.status === "done") {
        setPlan(data.plan);
        setRemaining(data.remaining ?? null);
        setLoading(false);
        return;
      }
      if (data.status === "error") {
        setError(data.error || "生成失败，请稍后重试");
        setLoading(false);
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
      return poll();
    };
    await poll();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setPlan(null);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city, days, budget, preferences: prefs }),
      });
      const data = await res.json();
      if (res.status === 202 && data.jobId) {
        await pollJob(data.jobId); // 长任务：轮询直到完成
        return;
      }
      setError(data.error || "提交失败，请稍后重试");
      setLoading(false);
    } catch {
      setError("网络异常，请稍后重试");
      setLoading(false);
    }
  }

  return (
    <main className="container">
      <h1>行程规划师</h1>
      <p className="subtitle">国内城市 3-4 天行程：AI 生成 + 真实 POI 验真，把绕路和幻觉挡在出发前</p>

      <form className="card" onSubmit={onSubmit}>
        <div className="row">
          <div>
            <label>目的地城市</label>
            <input value={city} onChange={(e) => setCity(e.target.value)}
                   placeholder="如：成都" maxLength={20} required />
          </div>
          <div>
            <label>天数</label>
            <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={3}>3 天</option>
              <option value={4}>4 天</option>
            </select>
          </div>
          <div>
            <label>人均预算（元，不含大交通）</label>
            <input type="number" value={budget} min={500} step={100}
                   onChange={(e) => setBudget(Number(e.target.value))} required />
          </div>
        </div>

        <label>出行偏好（可多选）</label>
        <div className="chips">
          {PREF_OPTIONS.map((p) => (
            <span key={p} className={`chip ${prefs.includes(p) ? "on" : ""}`}
                  onClick={() => togglePref(p)}>{p}</span>
          ))}
        </div>

        <button className="primary" disabled={loading}>
          {loading ? `生成中…已等待 ${fmtElapsed(elapsed)}` : "生成行程"}
        </button>
        {loading ? (
          <p className="muted" style={{ marginTop: 8 }}>{WAITING_TIPS[tipIndex]}</p>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>
            推理模型做约束规划需要 2-4 分钟：先推演预算与动线约束，再输出完整行程，
            可以放着等，页面上方会实时显示进度。
          </p>
        )}
        {remaining !== null && (
          <p className="muted" style={{ marginTop: 4 }}>今日剩余免费次数：{remaining}</p>
        )}
      </form>

      {error && <div className="error">{error}</div>}

      {plan && (
        <>
          <div className="card">
            <h2>{plan.city} · {plan.days.length} 天行程</h2>
            <p className="summary-line">{plan.summary}</p>
            <p className="muted">
              合计人均约 ¥{plan.totalCostCny.toLocaleString()}
              {" · "}{plan.verified ? "POI 已通过高德验真" : "MOCK 模式：未接高德，POI 未验真"}
            </p>
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(toMarkdown(plan));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={{
                marginTop: 8, padding: "6px 14px", fontSize: 13, cursor: "pointer",
                border: "1px solid var(--border)", borderRadius: 8, background: "#fff",
              }}
            >
              {copied ? "✅ 已复制 Markdown" : "复制 Markdown"}
            </button>
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
                当天通勤约 {Math.round(day.transitMin / 6) / 10}h · 人均 ¥{day.dailyCostCny.toLocaleString()}
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
      )}
    </main>
  );
}
