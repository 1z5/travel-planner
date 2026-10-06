"use client";

import { useEffect, useState } from "react";
import type { Plan } from "@/lib/types";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { PlanView } from "@/components/PlanView";

const PREF_OPTIONS = [
  "美食", "历史文化", "自然风光", "Citywalk", "博物馆",
  "购物", "拍照打卡", "小众冷门", "亲子友好", "夜生活",
];

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

export default function Home() {
  const [city, setCity] = useState("成都");
  const [days, setDays] = useState(4);
  const [budget, setBudget] = useState(3000);
  const [prefs, setPrefs] = useState<string[]>(["美食", "历史文化"]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);
  const [sampleMode, setSampleMode] = useState(false);
  // 新增：用户指定住所 + 期望必游地（硬约束）
  const [hotel, setHotel] = useState("");
  const [mustVisit, setMustVisit] = useState<string[]>([]);
  const [mvInput, setMvInput] = useState("");
  // 行程节奏：轻松/适中/紧凑
  const [pace, setPace] = useState<"relaxed" | "balanced" | "packed">("balanced");

  // ---- 登录态（可选：未登录 3 次/天，登录后 10 次/天）----
  const [me, setMe] = useState<{ loggedIn: boolean; phone?: string; remaining: number | null; provider: string } | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => setMe(null));
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    setAuthError("");
    const r = await fetch("/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    const d = await r.json();
    if (!r.ok) {
      setAuthError(d.error || "发送失败");
      return;
    }
    setCooldown(60);
  }

  async function login() {
    setAuthError("");
    const r = await fetch("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code }),
    });
    const d = await r.json();
    if (!r.ok) {
      setAuthError(d.error || "登录失败");
      return;
    }
    setLoginOpen(false);
    setCode("");
    const meData = await (await fetch("/api/me")).json();
    setMe(meData);
    setRemaining(null);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe({ loggedIn: false, remaining: null, provider: me?.provider ?? "none" });
  }

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
        setJobId(jobId);
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

  const displayPlan = plan ?? (sampleMode ? SAMPLE_PLAN : null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setPlan(null);
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          days,
          budget,
          preferences: prefs,
          hotel: hotel.trim() || undefined,
          mustVisit,
          pace,
        }),
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

        <label>行程节奏</label>
        <div className="chips">
          {([
            ["relaxed", "轻松（每天 1-3 个主景点）"],
            ["balanced", "适中（2-4 个）"],
            ["packed", "紧凑（3-5 个）"],
          ] as const).map(([value, label]) => (
            <span key={value}
              className={`chip ${pace === value ? "on" : ""}`}
              onClick={() => setPace(value)}>{label}</span>
          ))}
        </div>

        <label>我的住所（选填，全程以此为基地）</label>
        <input value={hotel} onChange={(e) => setHotel(e.target.value)}
               placeholder='如：全季酒店(春熙路店)，或"住春熙路附近"' maxLength={40} />

        <label>期望必游地（选填，最多 5 个，必须全部安排）</label>
        <div className="chips">
          {mustVisit.map((m) => (
            <span key={m} className="chip on">
              {m}
              <span onClick={() => setMustVisit((cur) => cur.filter((x) => x !== m))}
                style={{ marginLeft: 6, cursor: "pointer" }}>×</span>
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <input value={mvInput} onChange={(e) => setMvInput(e.target.value)}
                 placeholder="输入地名后点添加，或回车" maxLength={20}
                 onKeyDown={(e) => {
                   if (e.key === "Enter") {
                     e.preventDefault();
                     const v = mvInput.trim();
                     if (v && mustVisit.length < 5 && !mustVisit.includes(v)) {
                       setMustVisit((cur) => [...cur, v]);
                       setMvInput("");
                     }
                   }
                 }} />
          <button type="button"
            onClick={() => {
              const v = mvInput.trim();
              if (v && mustVisit.length < 5 && !mustVisit.includes(v)) {
                setMustVisit((cur) => [...cur, v]);
                setMvInput("");
              }
            }}
            style={{ flex: "0 0 auto", padding: "9px 16px", border: "1px solid var(--border)",
                     borderRadius: 8, background: "#fff", cursor: "pointer" }}>
            添加
          </button>
        </div>
        {mustVisit.length >= 5 && (
          <p className="muted" style={{ marginTop: 4 }}>最多 5 个必游地</p>
        )}

        <label>出行偏好（可多选）</label>
        <div className="chips">
          {PREF_OPTIONS.map((p) => (
            <span key={p} className={`chip ${prefs.includes(p) ? "on" : ""}`}
                  onClick={() => togglePref(p)}>{p}</span>
          ))}
        </div>

        {/* 登录区：可选增强，未登录 3 次/天，登录后 10 次/天 */}
        <div style={{ marginTop: 16, borderTop: "1px dashed var(--border)", paddingTop: 12 }}>
          {me?.loggedIn ? (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted">
                已登录：{me.phone?.startsWith("wx:") ? "微信用户" : me.phone?.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2")}
                {me.remaining !== null && ` · 今日剩余 ${me.remaining} 次`}
              </span>
              <button type="button" onClick={logout}
                style={{ border: "none", background: "none", color: "var(--muted)", cursor: "pointer", textDecoration: "underline", fontSize: 13 }}>
                退出登录
              </button>
            </div>
          ) : loginOpen ? (
            <>
              <div className="row">
                <input placeholder="手机号" value={phone} maxLength={11}
                       onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
                <div className="row">
                  <input placeholder="验证码" value={code} maxLength={6}
                         onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                  <button type="button" onClick={sendCode} disabled={cooldown > 0 || phone.length !== 11}
                    style={{ whiteSpace: "nowrap", border: "1px solid var(--border)", borderRadius: 8, background: "#fff", cursor: "pointer" }}>
                    {cooldown > 0 ? `${cooldown}s` : "获取验证码"}
                  </button>
                </div>
                <button type="button" onClick={login} disabled={phone.length !== 11 || code.length < 4}
                  style={{ whiteSpace: "nowrap", border: "1px solid var(--accent)", borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent)", cursor: "pointer" }}>
                  登录
                </button>
              </div>
              {me?.provider === "none" && (
                <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>开发模式（未接短信服务），验证码固定为 123456</p>
              )}
            </>
          ) : (
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <button type="button" onClick={() => setLoginOpen(true)}
                style={{ border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 14, padding: 0 }}>
                手机号登录：未登录每天 3 次，登录后 10 次 →
              </button>
              {me?.provider === "wechat" && (
                <a href="/api/auth/wechat/login?redirect=/"
                  style={{ border: "none", background: "none", color: "#07c160", cursor: "pointer", fontSize: 14, textDecoration: "none" }}>
                  微信一键登录 →
                </a>
              )}
            </div>
          )}
          {authError && <p className="error" style={{ marginTop: 8, marginBottom: 0 }}>{authError}</p>}
        </div>

        <button className="primary" disabled={loading}>
          {loading ? `生成中…已等待 ${fmtElapsed(elapsed)}` : "生成行程"}
        </button>
        {loading ? (
          <p className="muted" style={{ marginTop: 8 }}>{WAITING_TIPS[tipIndex]}</p>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>
            推理模型做约束规划通常 2-4 分钟，跨境目的地（如香港）可能 8 分钟以上，
            可以放着等，页面上方会实时显示进度。
          </p>
        )}
        {remaining !== null && (
          <p className="muted" style={{ marginTop: 4 }}>今日剩余免费次数：{remaining}</p>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          生成通常 2-4 分钟（跨境更久），等不及？{" "}
          <button type="button" onClick={() => setSampleMode(true)}
            style={{ border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, padding: 0, textDecoration: "underline" }}>
            看一个真实生成的示例（苏州 3 天）
          </button>
        </p>
      </form>

      {error && <div className="error">{error}</div>}

      {displayPlan && (
        <PlanView
          plan={displayPlan}
          shareId={sampleMode ? undefined : jobId ?? undefined}
          banner={sampleMode ? (
            <div className="card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14 }}>以上是一份<b>真实生成的示例</b>（预置数据，非本次生成）——这就是产品的输出质量。</span>
                <button type="button" onClick={() => setSampleMode(false)}
                  style={{ border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}>
                  收起示例
                </button>
              </div>
            </div>
          ) : undefined}
        />
      )}
    </main>
  );
}
