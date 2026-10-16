"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Plan } from "@/lib/types";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { AlertTriangle, Sparkles, ShieldCheck, Route, Stethoscope } from "lucide-react";
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

// 轮询兜底三件事（以前只有「3 秒一次、直到 done/error」）：
// 1. 任务 404（服务重启 / 超过 2 小时 TTL）必须立即报错——否则
//    data.status 是 undefined，会永远每 3 秒转一次圈，用户等到天荒地老
// 2. 单次网络抖动重试几次：3 分钟的等待不该被一次抖动毁掉
// 3. 总超时：服务端异常卡死时不能无限轮询
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 15 * 60_000;
const POLL_MAX_NET_ERRORS = 3;

function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

// 首页交互部分：封面 + 表单 + 轮询 + 行程展示。
// 营销/FAQ/页脚（LandingSections）由服务端的 app/page.tsx 以 children
// 传入，在本组件的表单之后渲染——这样那部分 JS 完全不进客户端包。
// 注意：client component 直接 import 的模块仍会被打进客户端包（实测确认
// 过），只有 children 传递才是真正的服务端组件边界。
export function HomeClient({ children }: { children?: ReactNode }) {
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
  // 本次提交的总天数：分日流式路径下用于显示「已生成 N/M 天」
  const [submittedDays, setSubmittedDays] = useState<number | null>(null);

  // 卸载标记：轮询是长任务（分钟级），用户离开页面后必须停止，
  // 否则既白烧请求又可能在卸载后 setState
  const unmounted = useRef(false);
  useEffect(() => () => { unmounted.current = true; }, []);

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
    const deadline = Date.now() + POLL_MAX_MS;
    let netErrors = 0;
    const poll = async (): Promise<void> => {
      if (unmounted.current) return; // 组件已卸载：停止轮询，别再发无谓请求
      if (Date.now() > deadline) {
        setError("等待超时（15 分钟）。生成可能仍在后台继续，可重新提交一次");
        setLoading(false);
        return;
      }
      let data: { status?: string; plan?: Plan; error?: string; remaining?: number };
      try {
        const res = await fetch(`/api/plan/status?id=${jobId}`);
        if (res.status === 404) {
          // 任务不存在/已过期（服务重启或超过 2 小时 TTL）：
          // 继续轮询也不会有结果，必须立刻告诉用户
          setError("任务已过期或服务已重启，请重新生成");
          setLoading(false);
          return;
        }
        data = await res.json();
        netErrors = 0; // 通一次就重置抖动计数
      } catch {
        netErrors += 1;
        if (netErrors >= POLL_MAX_NET_ERRORS) {
          setError("网络不稳定，连接已中断，请重新生成");
          setLoading(false);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        return poll();
      }
      if (data.status === "done") {
        setPlan(data.plan ?? null);
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
      // running：分日流式路径（≥5 天）会增量回传已生成的天。
      // 立即渲染，让用户逐天看到结果，而不是干等一个总 deadline。
      // 注意此时不设 jobId——分享页只认 status=done 的任务，
      // 中途把链接给出去只会看到「链接已失效」。
      if (data.plan) setPlan(data.plan);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
    setSubmittedDays(derivedDays); // 记录本次提交的总天数，供「已生成 N/M 天」使用
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
            <label htmlFor="city">目的地城市</label>
            <input id="city" type="text" value={city} onChange={(e) => setCity(e.target.value)}
                   placeholder="如：成都" maxLength={20} required />
            <div className="chips" style={{ marginTop: 8 }}>
              {["成都", "西安", "杭州", "厦门", "重庆", "苏州"].map((c) => (
                <span key={c} className={`chip ${city === c ? "on" : ""}`}
                      role="button" tabIndex={0} aria-pressed={city === c}
                      onClick={() => setCity(c)}
                      onKeyDown={(e) => {
                        // chip 是 span+role=button（保留 .chip 视觉）：必须自己接住
                        // Enter/Space，否则键盘用户完全无法选择城市/偏好
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setCity(c); }
                      }}>
                  {c}
                </span>
              ))}
            </div>
            <p className="helper">目前支持国内城市，1-7 天</p>
          </div>
          <div>
            <label htmlFor="budget">人均预算（元，不含大交通）</label>
            <input id="budget" type="number" value={budget} min={500} step={100}
                   onChange={(e) => setBudget(Number(e.target.value))} required />
          </div>
        </div>

        <div className="row">
          <div>
            <label htmlFor="startAt">起始时间</label>
            <input id="startAt" type="datetime-local" value={startAt}
                   onChange={(e) => setStartAt(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="endAt">结束时间</label>
            <input id="endAt" type="datetime-local" value={endAt}
                   onChange={(e) => setEndAt(e.target.value)} required />
          </div>
        </div>
        {derivedDays !== null && (
          <p className="muted" style={{ marginTop: 4 }}>
            共 {derivedDays} 天{derivedDays > 7 ? "（超过 7 天的部分暂不支持）" : ""}
            {derivedDays === 1 ? "（当天往返）" : ""}
          </p>
        )}

          <label id="pace-label">行程节奏</label>
          <div className="segmented" role="group" aria-labelledby="pace-label">
            {([
              ["relaxed", "轻松", "每天 1-3 个主景点"],
              ["balanced", "适中", "每天 2-4 个"],
              ["packed", "紧凑", "每天 3-5 个"],
            ] as const).map(([value, label, desc]) => (
              <button type="button" key={value}
                className={pace === value ? "on" : ""}
                aria-pressed={pace === value}
                onClick={() => setPace(value)}>
                {label}<small>{desc}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <div className="legend">你的约束<span className="optional-tag">选填 · 让行程围着你的安排转</span></div>
          <label htmlFor="hotel">我的住所</label>
        <input id="hotel" type="text" value={hotel} onChange={(e) => setHotel(e.target.value)}
               placeholder='如：全季酒店(春熙路店)，或"住春熙路附近"' maxLength={40} />

          <label htmlFor="must-visit-input">期望必游地<span className="optional-tag">最多 5 个，必须全部安排</span></label>
        <div className="chips">
          {mustVisit.map((m) => (
            <span key={m} className="chip on">
              {m}
              <span role="button" tabIndex={0} aria-label={`删除必游地 ${m}`}
                onClick={() => setMustVisit((cur) => cur.filter((x) => x !== m))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setMustVisit((cur) => cur.filter((x) => x !== m));
                  }
                }}
                style={{ marginLeft: 6, cursor: "pointer" }}>×</span>
            </span>
          ))}
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <input id="must-visit-input" type="text" value={mvInput} onChange={(e) => setMvInput(e.target.value)}
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
                  role="button" tabIndex={0} aria-pressed={prefs.includes(p)}
                  onClick={() => togglePref(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); togglePref(p); }
                  }}>{p}</span>
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
                <input type="text" placeholder="手机号" aria-label="手机号" value={phone} maxLength={11}
                       onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
                <div className="row">
                  <input type="text" placeholder="验证码" aria-label="验证码" value={code} maxLength={6}
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
          <p className="muted" role="status" style={{ marginTop: 8 }}>{WAITING_TIPS[tipIndex]}</p>
        ) : (
          <p className="muted" style={{ marginTop: 8 }}>
            推理模型做约束规划通常 2-4 分钟，跨境目的地（如香港）可能 8 分钟以上，
            可以放着等，页面上方会实时显示进度。
          </p>
        )}
        {/* 分日流式进度：≥5 天的行程会逐天生成，这里告诉用户进度，
            避免长任务下只看到一个总 deadline 干等 */}
        {loading && submittedDays !== null && submittedDays >= 5 && plan && plan.days.length > 0 && (
          <p className="muted" role="status" style={{ marginTop: 4 }}>
            已生成 {plan.days.length}/{submittedDays} 天——下方行程随生成进度逐天出现
          </p>
        )}
        {remaining !== null && (
          <p className="muted" role="status" style={{ marginTop: 4 }}>今日剩余免费次数：{remaining}</p>
        )}
        <p className="muted" style={{ marginTop: 8 }}>
          生成通常 2-4 分钟（跨境更久），等不及？{" "}
          <button type="button" onClick={() => setSampleMode(true)} className="btn-link" style={{ fontSize: 13, textDecoration: "underline" }}>
            看一个真实生成的示例（苏州 3 天）
          </button>
        </p>
      </motion.form>

      {/* 营销/FAQ/页脚：服务端组件经 children 渲染在此，零客户端 JS */}
      {children}

      {error && <div className="alert alert-error" role="alert"><AlertTriangle size={16} style={{ marginTop: 2 }} />{error}</div>}

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
