"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Plan, PlanEvent } from "@/lib/types";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { AlertTriangle, MapPin } from "lucide-react";
import { motion } from "framer-motion";
import { formatCny } from "@/lib/budget";
import { PlanView } from "@/components/PlanView";
import { AddressInput } from "@/components/AddressInput";
import { LiveProgress } from "@/components/LiveProgress";
import { ProfileDrawer } from "@/components/ProfileDrawer";
import { saveRecentTrip } from "@/lib/recent-trips";
import { loadProfile } from "@/lib/profile-store";

const PREF_OPTIONS = [
  "美食",
  "历史文化",
  "自然风光",
  "Citywalk",
  "博物馆",
  "购物",
  "拍照打卡",
  "小众冷门",
  "亲子友好",
  "夜生活",
];

/** 预算快捷档（元）。0 = 穷游，是合法输入而非异常值 */
const BUDGET_PRESETS = [0, 1000, 3000, 8000];

// 等待期的阶段提示已移入 LiveProgress：管线遥测（stage）存在时展示**真实
// 阶段清单**，无遥测（旧任务）时才轮换泛化提示。这里不再保留按时间轮换的
// WAITING_TIPS——真实进度比泛化提示诚实，两者并存会互相矛盾。

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

// 新建行程页的交互部分：表单 + 轮询 + 行程展示。
// 产品入口 /（我的行程）负责回访与索引；营销故事在 /about。
// 这个组件只在 (app)/new 使用，不再承担首页/落地页职责。
export function HomeClient() {
  // 目的地城市默认不预填：挂载时尝试静默定位，拿到定位城市才填，拿不到
  // （无权限/不支持/失败）就空着让用户自己输——不拿一个硬编码城市冒充默认值。
  const [city, setCity] = useState("");
  const [startAt, setStartAt] = useState(() => {
    const d = new Date(Date.now() + 86400000);
    return `${d.toISOString().slice(0, 10)}T10:00`;
  });
  const [endAt, setEndAt] = useState(() => {
    const d = new Date(Date.now() + 4 * 86400000); // 明天出发 + 4 天 = 5 个日历日中的 4 天行程
    return `${d.toISOString().slice(0, 10)}T18:00`;
  });
  // 预算不预填：原来的 3000 是「替用户做决定」，也让人以为这是默认值/最低消费。
  // 空着 + 占位符给口径，提交前拦截（与城市同一套路），并提供快捷档（含穷游 0）。
  const [budget, setBudget] = useState("");
  const [prefs, setPrefs] = useState<string[]>(["美食", "历史文化"]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState<number | null>(null);
  // 持久化分享 token：任务完成后服务端会为行程签发一个持久 token（Plan 聚合），
  // 分享/日历/继续编辑都用它。不再用 jobId——任务只有 2 小时生命周期，拿它做分享
  // 链接会让「分享给朋友」在两小时后变成「链接已失效」。
  const [shareId, setShareId] = useState<string | null>(null);
  // 预算解析：空/非整数/负数/超上限都算「没填好」——按钮禁用并给可行动文案，
  // 不让用户提交后才收到一条 400。
  const budgetNum = Number(budget);
  const budgetOk =
    budget.trim() !== "" && Number.isInteger(budgetNum) && budgetNum >= 0 && budgetNum <= 200000;
  const [elapsed, setElapsed] = useState(0);
  // 管线阶段遥测（服务端在真实节点写入，见 lib/jobs.ts JobStage）：
  // undefined = 旧任务/无遥测 → LiveProgress 降级为不确定进度条。
  const [stage, setStage] = useState<string | undefined>(undefined);
  const [sampleMode, setSampleMode] = useState(false);
  // 结果出现后（真实行程或示例），规划表单默认收起为一行摘要：
  // 企业级产品的「工作区」在结果页应该以结果为主，而不是让用户
  // 先滚过一张 1000px 的表单才能看到行程。展开即可继续调整/重新生成。
  const [formOpen, setFormOpen] = useState(false);
  // 新增：用户指定住所 + 期望必游地（硬约束）
  const [hotel, setHotel] = useState("");
  const [mustVisit, setMustVisit] = useState<string[]>([]);
  const [mvInput, setMvInput] = useState("");
  // 重点活动：用户提供的演唱会/赛事/展览等（名称必填，日期时间可选）
  const [events, setEvents] = useState<PlanEvent[]>([]);
  const [evName, setEvName] = useState("");
  const [evDate, setEvDate] = useState("");
  const [evTime, setEvTime] = useState("");
  // 行程节奏：轻松/适中/紧凑
  const [pace, setPace] = useState<"relaxed" | "balanced" | "packed">("balanced");
  // 交通方式：决定每天各景点间怎么走（串成路线链）。默认驾车。
  const [transportMode, setTransportMode] = useState<"walking" | "bicycling" | "driving">(
    "driving",
  );
  // 规划范围：单城市 / 区域环线（影响 prompt、POI 验真方式与天数上限）
  const [scope, setScope] = useState<"city" | "region">("city");
  // POI 补全的城市收窄口径：区域模式下目的地是「川西环线」这类区域名而不是
  // 城市，传给高德会被静默忽略（实测 infocode 10000 / count 1000，直接返回
  // 全国结果）——既收窄不到，还可能把恰好同名的真实城市误当成约束、排掉
  // 区域里其他城市的 POI（如「大理」既是城市也可指大理州）。所以区域模式下
  // 不收窄，补全按关键词全国搜，诚实优于假装精准。
  const poiCity = scope === "region" ? undefined : city;
  // 本次提交的总天数：分日流式路径下用于显示「已生成 N/M 天」
  const [submittedDays, setSubmittedDays] = useState<number | null>(null);
  // 实时定位：把「我在哪」变成默认起点。定位是增强不是门槛，
  // 所有失败路径都降级为「请手动输入」，绝不阻塞主流程。
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState("");
  const [locatedCity, setLocatedCity] = useState("");

  // 卸载标记：轮询是长任务（分钟级），用户离开页面后必须停止，
  // 否则既白烧请求又可能在卸载后 setState。
  //
  // 必须在 setup 里显式复位成 false，不能只靠 useRef(false) 的初值：
  // React StrictMode（dev 默认开）会「挂载→卸载→再挂载」，第一次 cleanup
  // 把标记置 true 后，第二次挂载的 setup 若不复位，标记就永远卡在 true——
  // 于是 pollJob 第一行 if (unmounted.current) return 直接返回，一次轮询都
  // 不发，前端干等到超时（真机踩过：深圳任务后台 328s 就跑完了，前端干等
  // 20 分钟没结果，而四道门全绿——因为组件测试没在 StrictMode 下渲染）。
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  // ---- 登录态（可选：未登录 3 次/天，登录后 10 次/天）----
  const [me, setMe] = useState<{
    loggedIn: boolean;
    phone?: string;
    remaining: number | null;
    provider: string;
  } | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe(null));
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

  function togglePref(p: string) {
    setPrefs((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));
  }

  // 添加期望必游地：回车与点「添加」按钮共用。上限 5 个、去重、忽略空白。
  function addMustVisit() {
    const v = mvInput.trim();
    if (v && mustVisit.length < 5 && !mustVisit.includes(v)) {
      setMustVisit((cur) => [...cur, v]);
      setMvInput("");
    }
  }

  // 实时定位：浏览器拿坐标 → 服务端逆地理编码换城市名 → 自动填入输入框。
  //
  // 设计原则：定位是增强不是门槛，所有失败路径都降级为「请手动输入」，
  // 绝不阻塞主流程。三个必须处理的现实约束：
  // 1. geolocation 只在安全上下文（HTTPS 或 localhost）可用——http 部署
  //    时浏览器直接不给位置，提前判断并给明确提示
  // 2. 用户可能拒绝授权、或迟迟不给位置（超时）——都要能降级
  // 3. 坐标可能落在海上/荒野，归属不到城市——服务端返回 422，同样降级
  // 定位并反解城市名。silent=true 时（挂载时的自动预填）不写 locateError——
  // 一进页面就因为没给定位权限弹一片红是很糟的体验，那时保持空让用户自己输。
  // 返回是否成功，供调用方决定后续。
  async function resolveCity(silent: boolean): Promise<boolean> {
    setLocateError("");
    if (!silent) setLocatedCity("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      if (!silent) setLocateError("当前浏览器不支持定位，请手动输入城市");
      return false;
    }
    if (!window.isSecureContext) {
      if (!silent) setLocateError("定位需要 HTTPS 环境，请手动输入城市");
      return false;
    }
    setLocating(true);
    try {
      const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          timeout: 10_000,
          maximumAge: 60_000, // 复用 1 分钟内的旧位置，少弹一次授权确认
          enableHighAccuracy: false, // 城市级精度足够，省电且更快
        }),
      );
      const { longitude, latitude } = pos.coords;
      const r = await fetch(`/api/geocode/reverse?lng=${longitude}&lat=${latitude}`);
      const d = await r.json();
      if (!r.ok) {
        if (!silent) setLocateError(d.error || "定位失败，请手动输入城市");
        return false;
      }
      setCity(d.city);
      setLocatedCity(d.formatted || d.city);
      return true;
    } catch (e) {
      // 1=拒绝授权 2=位置不可用 3=超时；其余归为未知失败
      const code = (e as GeolocationPositionError)?.code;
      if (!silent) {
        setLocateError(
          code === 1
            ? "定位权限被拒绝，请手动输入城市"
            : code === 3
              ? "定位超时，请手动输入城市"
              : "定位失败，请手动输入城市",
        );
      }
      return false;
    } finally {
      setLocating(false);
    }
  }

  async function locateMe() {
    await resolveCity(false);
  }

  // 挂载时静默定位一次：拿到定位城市就预填，拿不到就留空（用户自己输）。
  // 只在挂载时跑一次；用户之后可点「用我当前的位置」主动重定位。
  useEffect(() => {
    void resolveCity(true);
  }, []);

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
      let data: {
        status?: string;
        plan?: Plan;
        error?: string;
        remaining?: number;
        shareId?: string | null;
        stage?: string; // 管线阶段遥测（running 时；见 lib/jobs.ts JobStage）
      };
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
        const donePlan = data.plan ?? null;
        setPlan(donePlan);
        setShareId(data.shareId ?? null);
        setRemaining(data.remaining ?? null);
        setLoading(false);
        // 记进「最近行程」：只认持久化 token（有 token 才谈得上长期分享/继续编辑）。
        // 写入失败（隐私模式/配额满）静默降级，不影响结果展示。
        if (data.shareId && donePlan) {
          saveRecentTrip({
            shareId: data.shareId,
            city: donePlan.city,
            days: donePlan.days.length,
            startDate: donePlan.startDate,
            summary: donePlan.summary,
            createdAt: Date.now(),
          });
        }
        return;
      }
      if (data.status === "error") {
        setError(data.error || "生成失败，请稍后重试");
        setLoading(false);
        return;
      }
      // running：分日流式路径（≥5 天）会增量回传已生成的天。
      // 立即渲染，让用户逐天看到结果，而不是干等一个总 deadline。
      // 注意此时还没有 shareId——分享/编辑按钮只在 done 之后出现，
      // 中途把链接给出去只会看到「链接已失效」。
      // stage 同步给 LiveProgress 渲染真实阶段清单；遥测缺失（旧任务）
      // 时置 undefined，由组件降级为不确定进度条（不猜阶段）。
      if (data.plan) setPlan(data.plan);
      setStage(data.stage);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      return poll();
    };
    await poll();
  }

  const displayPlan = plan ?? (sampleMode ? SAMPLE_PLAN : null);

  // 由起止时间推导天数（日历日含头含尾），用于展示与提交前提示
  const derivedDays = (() => {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endAt)
    )
      return null;
    const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
    const en = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
    return Math.round((en - s) / 86400000) + 1;
  })();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setPlan(null);
    setShareId(null); // 新任务开始：旧的分享 token 与当前结果不再对应
    setSubmittedDays(derivedDays); // 记录本次提交的总天数，供「已生成 N/M 天」使用
    setStage(undefined); // 新任务：旧任务的阶段遥测作废（即使它还没被清）
    try {
      // 档案在**提交时现读**（不信缓存的 state）：用户在抽屉里刚改完档案就
      // 点生成，缓存会旧。localStorage 读取是廉价的，换来的是一致性。
      // 拿不到（没填过/坏数据）= 不传 = 与加档案前逐字一致的行为。
      const profile = loadProfile();
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city,
          startAt,
          endAt,
          budget: budgetNum,
          preferences: prefs,
          hotel: hotel.trim() || undefined,
          mustVisit,
          pace,
          scope,
          transportMode,
          events,
          ...(profile ? { profile } : {}),
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

  // 等待进度：LiveProgress 自己按 stage + plan 判定流式/单次路径——
  // 流式路径画确定性进度（真实 N/M 天），单次路径画不确定动画条
  // （草稿天数不是生成天数，不假装百分比）。确定性判定在组件内完成，
  // 这里不再重复计算。

  return (
    <main className={displayPlan ? "has-result" : undefined}>
      {/* 旅行档案（切片3）：fixed 定位的入口 FAB + 抽屉，挂在 main 第一位。
          挂在这里而不是表单内：档案是跨行程的长期资产，不属于任何一次
          表单提交；fixed 定位也让它在首页任何滚动位置都可唤起。 */}
      <ProfileDrawer />
      <header className="new-head">
        <div className="container new-head-inner">
          <Link href="/" className="new-back">
            ← 我的行程
          </Link>
          <p className="new-eyebrow">NEW TRIP · 新建行程</p>
          <h1 className="new-title">这次想去哪？</h1>
          <p className="new-sub">
            先核验真实世界，再排行程。生成约 2-4 分钟，期间可以离开页面，结果会留在这份行程里。
          </p>
        </div>
      </header>

      <div className="container">
        {displayPlan && (
          <div className="form-fold">
            <div className="form-fold-info">
              <span className="form-fold-title">
                {sampleMode ? "示例行程" : "已生成行程"} · {displayPlan.city}
              </span>
              <span className="form-fold-meta">
                {displayPlan.days.length} 天 ·{" "}
                {displayPlan.budgetCny !== undefined
                  ? `预算 ${formatCny(displayPlan.budgetCny)}`
                  : `总花费 ${formatCny(displayPlan.totalCostCny)}`}
              </span>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFormOpen((o) => !o)}
              aria-expanded={formOpen}
            >
              {formOpen ? "收起条件" : "调整条件 / 重新生成"}
            </button>
          </div>
        )}
        <motion.form
          className={`panel${displayPlan && !formOpen ? " panel-hidden" : ""}`}
          onSubmit={onSubmit}
          initial={{ opacity: 0, y: 32 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <div className="field-group">
            <div className="legend">行程信息</div>
            <div className="row row-form">
              <div>
                <label htmlFor="city">目的地城市</label>
                <AddressInput
                  id="city"
                  label="目的地城市"
                  scope="city"
                  value={city}
                  onChange={setCity}
                  placeholder="如：成都"
                  maxLength={20}
                />
                {/* 实时定位：一键把当前位置设为起点。按钮用 type="button"——
                放在 form 里若误用默认类型会触发提交 */}
                <div className="locate-row">
                  <button
                    type="button"
                    className="btn btn-locate"
                    onClick={locateMe}
                    disabled={locating}
                    aria-busy={locating}
                  >
                    <MapPin size={14} />
                    {locating ? "定位中…" : "用我当前的位置"}
                  </button>
                  {locatedCity && (
                    <span className="helper" style={{ margin: 0 }}>
                      已定位到 {locatedCity}
                    </span>
                  )}
                </div>
                {locateError && (
                  <p className="helper" style={{ margin: 0, color: "var(--err-ink)" }}>
                    {locateError}
                  </p>
                )}
                <p className="helper">目前支持国内城市，1-7 天</p>
              </div>
              <div>
                <label htmlFor="budget">人均预算（元，不含大交通）</label>
                <input
                  id="budget"
                  type="number"
                  value={budget}
                  min={0}
                  step={50}
                  placeholder="如：1500；穷游/免费为主可填 0"
                  onChange={(e) => setBudget(e.target.value)}
                  required
                />
                {/* 快捷档：把「我大概这个量级」变成一次点击；穷游 0 放在第一档，
                    因为它正是被 min(500) 挡掉的那部分用户 */}
                <div className="chips" style={{ marginTop: 8 }}>
                  {BUDGET_PRESETS.map((v) => (
                    <span
                      key={v}
                      className={`chip ${budget === String(v) ? "on" : ""}`}
                      role="button"
                      tabIndex={0}
                      aria-pressed={budget === String(v)}
                      onClick={() => setBudget(String(v))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setBudget(String(v));
                        }
                      }}
                    >
                      {v === 0 ? "穷游 0" : v.toLocaleString("zh-CN")}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="row">
              <div>
                <label htmlFor="startAt">起始时间</label>
                <input
                  id="startAt"
                  type="datetime-local"
                  value={startAt}
                  onChange={(e) => setStartAt(e.target.value)}
                  required
                />
              </div>
              <div>
                <label htmlFor="endAt">结束时间</label>
                <input
                  id="endAt"
                  type="datetime-local"
                  value={endAt}
                  onChange={(e) => setEndAt(e.target.value)}
                  required
                />
              </div>
            </div>
            {derivedDays !== null && (
              <p className="muted" style={{ marginTop: 4 }}>
                共 {derivedDays} 天{derivedDays > 7 ? "（超过 7 天的部分暂不支持）" : ""}
                {derivedDays === 1 ? "（当天往返）" : ""}
              </p>
            )}

            <label id="scope-label">规划范围</label>
            <div className="segmented" role="group" aria-labelledby="scope-label">
              {(
                [
                  ["city", "单城市", "如：成都、京都"],
                  ["region", "区域环线", "如：川西环线、关西"],
                ] as const
              ).map(([value, label, desc]) => (
                <button
                  type="button"
                  key={value}
                  className={scope === value ? "on" : ""}
                  aria-pressed={scope === value}
                  onClick={() => setScope(value)}
                >
                  {label}
                  <small>{desc}</small>
                </button>
              ))}
            </div>
            <p className="helper">
              {scope === "city"
                ? "目前支持国内城市，1-7 天"
                : "区域环线跨多个城市/景区，住宿随线路迁移，支持 1-10 天"}
            </p>

            <label id="pace-label">行程节奏</label>
            <div className="segmented" role="group" aria-labelledby="pace-label">
              {(
                [
                  ["relaxed", "轻松", "每天 1-3 个主景点"],
                  ["balanced", "适中", "每天 2-4 个"],
                  ["packed", "紧凑", "每天 3-5 个"],
                ] as const
              ).map(([value, label, desc]) => (
                <button
                  type="button"
                  key={value}
                  className={pace === value ? "on" : ""}
                  aria-pressed={pace === value}
                  onClick={() => setPace(value)}
                >
                  {label}
                  <small>{desc}</small>
                </button>
              ))}
            </div>

            <label id="transport-label">交通方式</label>
            <div className="segmented" role="group" aria-labelledby="transport-label">
              {(
                [
                  ["walking", "步行", "景点间步行串连"],
                  ["bicycling", "骑行", "适合近距离散布"],
                  ["driving", "驾车", "跨区/远距最省时"],
                ] as const
              ).map(([value, label, desc]) => (
                <button
                  type="button"
                  key={value}
                  className={transportMode === value ? "on" : ""}
                  aria-pressed={transportMode === value}
                  onClick={() => setTransportMode(value)}
                >
                  {label}
                  <small>{desc}</small>
                </button>
              ))}
            </div>
            <p className="helper">
              按所选方式把每天各景点串成可跟着走的路线（含距离、时长与分步指引）。
            </p>
          </div>

          <div className="field-group">
            <div className="legend">
              你的约束<span className="optional-tag">选填 · 让行程围着你的安排转</span>
            </div>
            <label htmlFor="hotel">我的住所</label>
            <AddressInput
              id="hotel"
              label="我的住所"
              scope="poi"
              city={poiCity}
              value={hotel}
              onChange={setHotel}
              placeholder="如：全季酒店(春熙路店)"
              maxLength={40}
            />

            <label htmlFor="must-visit-input">
              期望必游地<span className="optional-tag">最多 5 个，必须全部安排</span>
            </label>
            <div className="chips">
              {mustVisit.map((m) => (
                <span key={m} className="chip on">
                  {m}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={`删除必游地 ${m}`}
                    onClick={() => setMustVisit((cur) => cur.filter((x) => x !== m))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setMustVisit((cur) => cur.filter((x) => x !== m));
                      }
                    }}
                    className="chip-remove"
                  >
                    ×
                  </span>
                </span>
              ))}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <AddressInput
                id="must-visit-input"
                label="期望必游地"
                scope="poi"
                city={poiCity}
                value={mvInput}
                onChange={setMvInput}
                placeholder="输入地名后点添加，或回车"
                maxLength={20}
                onSubmit={addMustVisit}
              />
              <button
                type="button"
                onClick={addMustVisit}
                style={{ flex: "0 0 auto" }}
                className="btn btn-tall"
              >
                添加
              </button>
            </div>
            {mustVisit.length >= 5 && (
              <p className="muted" style={{ marginTop: 4 }}>
                最多 5 个必游地
              </p>
            )}

            <label htmlFor="event-name">
              重点活动
              <span className="optional-tag">选填 · 演唱会/赛事/展览，AI 围着它编排当天动线</span>
            </label>
            <div className="event-row">
              <AddressInput
                id="event-name"
                label="重点活动名称"
                scope="poi"
                city={poiCity}
                value={evName}
                onChange={setEvName}
                placeholder="如：周杰伦演唱会（名称需真实存在）"
                maxLength={30}
              />
              <input
                id="event-date"
                type="date"
                aria-label="活动日期（可选）"
                value={evDate}
                onChange={(e) => setEvDate(e.target.value)}
              />
              <input
                id="event-time"
                type="time"
                aria-label="活动开始时间（可选）"
                value={evTime}
                onChange={(e) => setEvTime(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn event-add"
              disabled={!evName.trim() || events.length >= 3}
              onClick={() => {
                const name = evName.trim();
                if (!name || events.length >= 3) return;
                if (events.some((e) => e.name === name)) return; // 去重
                setEvents((cur) => [
                  ...cur,
                  {
                    name,
                    date: evDate || undefined,
                    time: evTime || undefined,
                  },
                ]);
                setEvName("");
                setEvDate("");
                setEvTime("");
              }}
            >
              添加活动
            </button>
            {events.length > 0 && (
              <div className="chips" style={{ marginTop: 8 }}>
                {events.map((ev, i) => (
                  <span key={`${ev.name}-${i}`} className="chip on">
                    {ev.name}
                    {ev.date && (
                      <small className="event-chip-meta">
                        {ev.date}
                        {ev.time ? ` ${ev.time}` : ""}
                      </small>
                    )}
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`删除活动 ${ev.name}`}
                      onClick={() => setEvents((cur) => cur.filter((_, j) => j !== i))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEvents((cur) => cur.filter((_, j) => j !== i));
                        }
                      }}
                      className="chip-remove"
                    >
                      ×
                    </span>
                  </span>
                ))}
              </div>
            )}
            {events.length >= 3 && (
              <p className="muted" style={{ marginTop: 4 }}>
                最多 3 个重点活动
              </p>
            )}
            <p className="helper">
              名称会用高德验真（不存在会告警）；给了开始时间就会围绕它倒推动线，并预留提前到场
            </p>
          </div>

          <div className="field-group">
            <div className="legend">出行偏好</div>
            <div className="chips">
              {PREF_OPTIONS.map((p) => (
                <span
                  key={p}
                  className={`chip ${prefs.includes(p) ? "on" : ""}`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={prefs.includes(p)}
                  onClick={() => togglePref(p)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      togglePref(p);
                    }
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          </div>

          {/* 登录区：可选增强，未登录 3 次/天，登录后 10 次/天 */}
          <div className="login-panel">
            {me?.loggedIn ? (
              <div className="login-logged">
                <span className="muted">
                  已登录：
                  {me.phone?.startsWith("wx:")
                    ? "微信用户"
                    : me.phone?.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2")}
                  {me.remaining !== null && ` · 今日剩余 ${me.remaining} 次`}
                </span>
                <button type="button" onClick={logout} className="login-logout">
                  退出登录
                </button>
              </div>
            ) : loginOpen ? (
              <div className="login-form">
                <div className="login-row">
                  <input
                    type="text"
                    placeholder="手机号"
                    aria-label="手机号"
                    value={phone}
                    maxLength={11}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    type="button"
                    onClick={sendCode}
                    disabled={cooldown > 0 || phone.length !== 11}
                    className="btn"
                  >
                    {cooldown > 0 ? `${cooldown}s` : "获取验证码"}
                  </button>
                </div>
                <div className="login-row">
                  <input
                    type="text"
                    placeholder="验证码"
                    aria-label="验证码"
                    value={code}
                    maxLength={6}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  />
                  <button
                    type="button"
                    onClick={login}
                    disabled={phone.length !== 11 || code.length < 4}
                    className="btn"
                  >
                    登录
                  </button>
                </div>
                {me?.provider === "none" && (
                  <p className="muted">开发模式（未接短信服务），验证码固定为 123456</p>
                )}
              </div>
            ) : (
              <div className="login-links">
                <button type="button" onClick={() => setLoginOpen(true)} className="btn-link">
                  手机号登录：未登录每天 3 次，登录后 10 次 →
                </button>
                {me?.provider === "wechat" && (
                  <a href="/api/auth/wechat/login?redirect=/" className="btn-link btn-link-wechat">
                    微信一键登录 →
                  </a>
                )}
              </div>
            )}
            {authError && <p className="error login-error">{authError}</p>}
          </div>

          {/* 提交区：企业级表单的「动作栏」——先把代价与产出说清楚
              （耗时 / 额度 / 结果留存），再给主按钮；错误与进度就地显示。 */}
          <div className="form-actions">
            <div className="form-actions-meta">
              <span>预计 2–4 分钟</span>
              <span className="fa-sep" aria-hidden="true" />
              <span>消耗 1 次免费额度</span>
              <span className="fa-sep" aria-hidden="true" />
              <span>结果永久保存 · 可分享</span>
            </div>
            <button className="btn-primary" disabled={loading || !city.trim() || !budgetOk}>
              {loading
                ? "生成中…"
                : !city.trim()
                  ? "请先填写目的地城市"
                  : !budgetOk
                    ? "请填写人均预算（穷游可填 0）"
                    : "生成行程"}
            </button>
            {loading && (
              <>
                <LiveProgress
                  stage={stage}
                  plan={plan}
                  submittedDays={submittedDays}
                  elapsed={fmtElapsed(elapsed)}
                />
                {plan?.draft && (
                  <p className="draft-hint" role="status">
                    已显示快速预览（结构就绪），精确行程生成中——通常 2-4 分钟
                  </p>
                )}
              </>
            )}
            {remaining !== null && (
              <p className="muted" role="status">
                今日剩余免费次数：{remaining}
              </p>
            )}
            <p className="form-actions-note">
              推理模型做约束规划通常 2–4
              分钟（跨境更久），生成过程中可以离开页面；进度与结果会保留。 等不及也可以
              <button type="button" onClick={() => setSampleMode(true)} className="btn-link">
                先看一份真实生成的示例（苏州 3 天）
              </button>
              。
            </p>
          </div>
        </motion.form>

        {error && (
          <div className="alert alert-error" role="alert">
            <AlertTriangle size={16} style={{ marginTop: 2 }} />
            {error}
          </div>
        )}

        {displayPlan && (
          <PlanView
            plan={displayPlan}
            shareId={sampleMode ? undefined : (shareId ?? undefined)}
            editable={!sampleMode && !!shareId}
            onPlanChange={(p) => setPlan(p)}
            banner={
              sampleMode ? (
                <div
                  className="card"
                  style={{ background: "var(--accent-soft)", borderColor: "var(--accent)" }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontSize: 14 }}>
                      以上是一份<b>真实生成的示例</b>
                      （预置数据，非本次生成）——这就是产品的输出质量。
                    </span>
                    <button
                      type="button"
                      onClick={() => setSampleMode(false)}
                      className="btn-link"
                      style={{ fontSize: 13, textDecoration: "underline" }}
                    >
                      收起示例
                    </button>
                  </div>
                </div>
              ) : undefined
            }
          />
        )}
      </div>
    </main>
  );
}
