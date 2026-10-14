"use client";

import { useEffect, useState } from "react";
import type { Plan } from "@/lib/types";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import {
  AlertTriangle, Sparkles, ShieldCheck, Route, Stethoscope,
} from "lucide-react";
import { motion } from "framer-motion";
import { cityImage } from "@/lib/city-images";
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
  const [startAt, setStartAt] = useState(() => {
    const d = new Date(Date.now() + 86400000);
    return `${d.toISOString().slice(0, 10)}T10:00`;
  });
  const [endAt, setEndAt] = useState(() => {
    const d = new Date(Date.now() + 4 * 86400000); // 明天出发 + 4 天 = 5 个日历日中的 4 天行程
    return `${d.toISOString().slice(0, 10)}T18:00`;
  });
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

  // 由起止时间推导天数（日历日含头含尾），用于展示与提交前提示
  const derivedDays = (() => {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endAt)) return null;
    const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
    const en = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
    return Math.round((en - s) / 86400000) + 1;
  })();

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
          startAt,
          endAt,
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
    <main>
      <header className="masthead">
        <motion.img key={city} className="masthead-bg" src={cityImage(city)} alt=""
          initial={{ scale: 1.08, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.9, ease: "easeOut" }} />
        <div className="masthead-veil" />
        <motion.div className="masthead-inner"
          initial={{ opacity: 0, y: 28 }} animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.15 }}>
          <span className="masthead-eyebrow"><Sparkles size={13} />AI 行程规划平台</span>
          <h1>去哪儿，都放心</h1>
          <p className="masthead-sub">
            任何目的地、任何天数——几分钟内得到一份经过事实核查的行程：
            每个景点真实存在，每段路线距离可信。
          </p>
          <div className="masthead-points">
            <span><ShieldCheck size={15} />POI 真实性验核</span>
            <span><Route size={15} />通勤距离实测</span>
            <span><Stethoscope size={15} />绕路与节奏体检</span>
          </div>
        </motion.div>
      </header>

      <div className="container">
      <motion.form className="panel" onSubmit={onSubmit}
        initial={{ opacity: 0, y: 32 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.3 }}>
        <div className="field-group">
          <div className="legend">行程信息</div>
          <div className="row row-form">
          <div>
            <label>目的地城市</label>
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)}
                   placeholder="如：成都" maxLength={20} required />
            <div className="chips" style={{ marginTop: 8 }}>
              {["成都", "西安", "杭州", "厦门", "重庆", "苏州"].map((c) => (
                <span key={c} className={`chip ${city === c ? "on" : ""}`}
                      onClick={() => setCity(c)}>{c}</span>
              ))}
            </div>
            <p className="helper">目前支持国内城市，1-4 天</p>
          </div>
          <div>
            <label>人均预算（元，不含大交通）</label>
            <input type="number" value={budget} min={500} step={100}
                   onChange={(e) => setBudget(Number(e.target.value))} required />
          </div>
        </div>

        <div className="row">
          <div>
            <label>起始时间</label>
            <input type="datetime-local" value={startAt}
                   onChange={(e) => setStartAt(e.target.value)} required />
          </div>
          <div>
            <label>结束时间</label>
            <input type="datetime-local" value={endAt}
                   onChange={(e) => setEndAt(e.target.value)} required />
          </div>
        </div>
        {derivedDays !== null && (
          <p className="muted" style={{ marginTop: 4 }}>
            共 {derivedDays} 天{derivedDays > 4 ? "（超过 4 天的部分暂不支持）" : ""}
            {derivedDays === 1 ? "（当天往返）" : ""}
          </p>
        )}

          <label>行程节奏</label>
          <div className="segmented">
            {([
              ["relaxed", "轻松", "每天 1-3 个主景点"],
              ["balanced", "适中", "每天 2-4 个"],
              ["packed", "紧凑", "每天 3-5 个"],
            ] as const).map(([value, label, desc]) => (
              <button type="button" key={value}
                className={pace === value ? "on" : ""}
                onClick={() => setPace(value)}>
                {label}<small>{desc}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <div className="legend">你的约束<span className="optional-tag">选填 · 让行程围着你的安排转</span></div>
          <label>我的住所</label>
        <input type="text" value={hotel} onChange={(e) => setHotel(e.target.value)}
               placeholder='如：全季酒店(春熙路店)，或"住春熙路附近"' maxLength={40} />

          <label>期望必游地<span className="optional-tag">最多 5 个，必须全部安排</span></label>
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
          <input type="text" value={mvInput} onChange={(e) => setMvInput(e.target.value)}
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
            style={{ flex: "0 0 auto" }} className="btn btn-tall">
            添加
          </button>
        </div>
        {mustVisit.length >= 5 && (
          <p className="muted" style={{ marginTop: 4 }}>最多 5 个必游地</p>
        )}

        </div>

        <div className="field-group">
          <div className="legend">出行偏好</div>
          <div className="chips">
          {PREF_OPTIONS.map((p) => (
            <span key={p} className={`chip ${prefs.includes(p) ? "on" : ""}`}
                  onClick={() => togglePref(p)}>{p}</span>
          ))}
          </div>
        </div>

        {/* 登录区：可选增强，未登录 3 次/天，登录后 10 次/天 */}
        <div className="login-panel">
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
                <input type="text" placeholder="手机号" value={phone} maxLength={11}
                       onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
                <div className="row">
                  <input type="text" placeholder="验证码" value={code} maxLength={6}
                         onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
                  <button type="button" onClick={sendCode} disabled={cooldown > 0 || phone.length !== 11}
                    style={{ whiteSpace: "nowrap" }} className="btn">
                    {cooldown > 0 ? `${cooldown}s` : "获取验证码"}
                  </button>
                </div>
                <button type="button" onClick={login} disabled={phone.length !== 11 || code.length < 4}
                  style={{ whiteSpace: "nowrap" }} className="btn">
                  登录
                </button>
              </div>
              {me?.provider === "none" && (
                <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>开发模式（未接短信服务），验证码固定为 123456</p>
              )}
            </>
          ) : (
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <button type="button" onClick={() => setLoginOpen(true)} className="btn-link">
                手机号登录：未登录每天 3 次，登录后 10 次 →
              </button>
              {me?.provider === "wechat" && (
                <a href="/api/auth/wechat/login?redirect=/" className="btn-link" style={{ color: "#07c160" }}>
                  微信一键登录 →
                </a>
              )}
            </div>
          )}
          {authError && <p className="error" style={{ marginTop: 8, marginBottom: 0 }}>{authError}</p>}
        </div>

        <button className="btn-primary" disabled={loading}>
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
          <button type="button" onClick={() => setSampleMode(true)} className="btn-link" style={{ fontSize: 13, textDecoration: "underline" }}>
            看一个真实生成的示例（苏州 3 天）
          </button>
        </p>
      </motion.form>

      <section className="how">
        <div className="legend">怎么做到的</div>
        <div className="how-grid">
          <div className="how-item">
            <span className="how-num">01</span>
            <h3>约束优先，不是聊天</h3>
            <p>预算、时间、地理、POI 真实性都是硬约束。模型只输出结构化行程，没有自由发挥的空间。</p>
          </div>
          <div className="how-item">
            <span className="how-num">02</span>
            <h3>逐点事实核查</h3>
            <p>每个景点、餐厅过高德 POI 验真，站点之间用真实驾驶距离估算通勤——排一个已关门的店，比没有推荐更糟。</p>
          </div>
          <div className="how-item">
            <span className="how-num">03</span>
            <h3>体检报告，不藏着</h3>
            <p>绕路、节奏失衡、预算超标、必游地漏排——所有风险摊开告诉你，改不改由你决定。</p>
          </div>
        </div>
      </section>

      <footer className="foot">
        <span>行程规划师 · AI 行程规划平台</span>
        <span>国内城市 1-4 天 · POI 数据来自高德开放平台</span>
      </footer>

      {error && <div className="alert alert-error"><AlertTriangle size={16} style={{ marginTop: 2 }} />{error}</div>}

      {displayPlan && (
        <PlanView
          plan={displayPlan}
          shareId={sampleMode ? undefined : jobId ?? undefined}
          banner={sampleMode ? (
            <div className="card" style={{ background: "var(--accent-soft)", borderColor: "var(--accent)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 14 }}>以上是一份<b>真实生成的示例</b>（预置数据，非本次生成）——这就是产品的输出质量。</span>
                <button type="button" onClick={() => setSampleMode(false)} className="btn-link" style={{ fontSize: 13, textDecoration: "underline" }}>
                  收起示例
                </button>
              </div>
            </div>
          ) : undefined}
        />
      )}
      </div>
    </main>
  );
}
