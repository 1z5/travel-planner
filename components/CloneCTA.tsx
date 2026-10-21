"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Copy } from "lucide-react";
import type { Plan } from "@/lib/types";
import { saveRecentTrip } from "@/lib/recent-trips";

// ============================================================
// 一键克隆 CTA（分享页挂载位，由海报封面组件预留）
//
// 产品语义：看到别人的行程 → 一键带出「按我的日期重排」的版本。这是病毒
// 飞轮的引擎：每一条分享链接都变成一个新用户的起点，而不是终点。
//
// 两条红线落在实现里：
// 1. **真克隆**：提交后走 POST /api/plan/clone → 完整生成管线（事实层对
//    新日期重新核验闭馆与通勤）。这里没有任何「复制 JSON 改日期」的捷径，
//    进行中提示也如实说「正在按你的日期重新核查」。
// 2. **诚实报错**：配额用完（429）直接透传服务端文案；任务过期/失败/超时
//    各自给出可行动的文案，不假装成功、不吞掉错误。
// ============================================================

// 轮询契约与首页完全一致（app/home-client.tsx 的 pollJob）：
// 3s 间隔 / 404 立即报错（任务过期或服务重启）/ 15 分钟总上限 /
// 单次网络抖动重试 3 次。克隆与首次生成是同一个异步任务模型，不搞第二套。
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 15 * 60_000;
const POLL_MAX_NET_ERRORS = 3;

// 进行中的确定性阶段提示（不猜百分比：单次调用路径拿不到真实进度）。
// 为什么轮换多条而不是一句话：克隆 = 一次完整生成，通常 2-4 分钟，
// 固定一句话容易让人以为卡死；这些文案全部对应管线里真实发生的阶段。
const CLONE_TIPS = [
  "正在按你的日期重新核查闭馆与通勤…",
  "正在按新档期重新检索 POI 与营业时间…",
  "正在按你的预算与节奏重排动线，并跑一遍体检…",
];

const PACE_OPTIONS = [
  ["relaxed", "轻松", "每天 1-3 个主景点"],
  ["balanced", "适中", "每天 2-4 个"],
  ["packed", "紧凑", "每天 3-5 个"],
] as const;

type Pace = "relaxed" | "balanced" | "packed";

/** 日期平移（"YYYY-MM-DD"，UTC 口径，不受本机时区影响） */
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/**
 * 默认出发/结束时间：原行程时间 +7 天（错峰）。
 *
 * 为什么 +7 天：完全相同的日期出发 = 和原主人撞上完全相同的闭馆/旺季
 * 条件，「换个日期再走一遍」的价值就没了；+7 天保持**星期几一致**（闭馆
 * 规则按星期几判定，新旧行程可以直接对照），又明显错开原档期。
 * 原行程没有日期时退回首页默认（明天出发 + 3 天）。
 */
function defaultStartAt(plan: Plan): string {
  const base = plan.startAt ?? (plan.startDate ? `${plan.startDate}T10:00` : null);
  if (base) return `${shiftDate(base.slice(0, 10), 7)}${base.slice(10)}`;
  const d = new Date(Date.now() + 86400000);
  return `${d.toISOString().slice(0, 10)}T10:00`;
}

function defaultEndAt(plan: Plan): string {
  const base = plan.endAt ?? (plan.endDate ? `${plan.endDate}T18:00` : null);
  if (base) return `${shiftDate(base.slice(0, 10), 7)}${base.slice(10)}`;
  const d = new Date(Date.now() + 4 * 86400000);
  return `${d.toISOString().slice(0, 10)}T18:00`;
}

/** 日历日含头含尾（与首页/服务端同一口径） */
function deriveDays(startAt: string, endAt: string): number | null {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(startAt) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(endAt)
  ) {
    return null;
  }
  const s = new Date(`${startAt.slice(0, 10)}T00:00:00Z`).getTime();
  const e = new Date(`${endAt.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((e - s) / 86400000) + 1;
}

export function CloneCTA({ plan, shareId }: { plan: Plan; shareId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [tipIndex, setTipIndex] = useState(0);
  const [stageNote, setStageNote] = useState("");
  const [startAt, setStartAt] = useState(() => defaultStartAt(plan));
  const [endAt, setEndAt] = useState(() => defaultEndAt(plan));
  // 预算预填：优先用户当初的预算（plan.budgetCny 由服务端从输入回填），
  // 没有则按这份行程的实际人均花费预填——表单默认值，用户随时可改。
  const [budget, setBudget] = useState(() => plan.budgetCny ?? plan.totalCostCny);
  // 节奏不预填原值：Plan 上不存 pace（输入层字段），诚实用产品的居中默认。
  const [pace, setPace] = useState<Pace>("balanced");

  // 卸载标记：轮询是分钟级长任务，用户离开页面（关闭表单不算）必须停止。
  // 必须在 setup 里显式复位：React StrictMode（dev 默认）会「挂载→卸载→
  // 再挂载」，只靠 useRef(false) 初值会让第二次挂载的轮询被第一行挡掉
  // （home-client 里踩过：任务早就完成，前端却干等到超时）。
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  // 等待期秒表
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // 等待期阶段提示轮换
  useEffect(() => {
    if (!busy) return;
    setTipIndex(0);
    const t = setInterval(() => setTipIndex((i) => (i + 1) % CLONE_TIPS.length), 4500);
    return () => clearInterval(t);
  }, [busy]);

  async function pollCloneJob(jobId: string): Promise<void> {
    const deadline = Date.now() + POLL_MAX_MS;
    let netErrors = 0;
    const poll = async (): Promise<void> => {
      if (unmounted.current) return; // 组件已卸载：停止轮询
      if (Date.now() > deadline) {
        setError("等待超时（15 分钟）。克隆可能仍在后台继续，可重新提交一次");
        setBusy(false);
        return;
      }
      let data: {
        status?: string;
        plan?: Plan;
        error?: string;
        shareId?: string | null;
      };
      try {
        const res = await fetch(`/api/plan/status?id=${jobId}`);
        if (res.status === 404) {
          // 任务不存在/已过期（服务重启或超过 2 小时 TTL）：继续轮询也不会有
          // 结果，立刻给可行动文案
          setError("任务已过期或服务已重启，请重新提交克隆");
          setBusy(false);
          return;
        }
        data = await res.json();
        netErrors = 0;
      } catch {
        netErrors += 1;
        if (netErrors >= POLL_MAX_NET_ERRORS) {
          setError("网络不稳定，连接已中断，请重新提交克隆");
          setBusy(false);
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        return poll();
      }
      if (data.status === "done") {
        const newPlan = data.plan ?? null;
        const newShareId = data.shareId ?? null;
        setBusy(false);
        if (newShareId && newPlan) {
          // 必须写「最近行程」：新主人跳转到 /p/<新 id>?edit=1 后要能编辑
          // 自己的行程，而 ownerCheck 认的是**本机 localStorage 索引**——
          // 漏了这一步，新行程打不开编辑入口（分享页的继续编辑形同虚设）。
          saveRecentTrip({
            shareId: newShareId,
            city: newPlan.city,
            days: newPlan.days.length,
            startDate: newPlan.startDate,
            summary: newPlan.summary,
            createdAt: Date.now(),
          });
          router.push(`/p/${newShareId}?edit=1`);
          return;
        }
        // 诚实降级：行程生成好了但持久化失败（shareId=null）——不装作能编辑
        setError(
          newPlan
            ? "行程已生成，但持久化失败，暂时没有可编辑的链接；请稍后重试"
            : "任务完成但没有返回行程，请稍后重试",
        );
        return;
      }
      if (data.status === "error") {
        setError(data.error || "克隆失败，请稍后重试");
        setBusy(false);
        return;
      }
      // running：分日流式（≥5 天）会增量回传已生成的天。只在有真实增量时
      // 提示，不编百分比。
      const ready = data.plan?.days.length ?? 0;
      setStageNote(ready > 0 ? `已生成 ${ready} 天` : "");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      return poll();
    };
    await poll();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setStageNote("");
    try {
      const res = await fetch("/api/plan/clone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shareId,
          overrides: { startAt, endAt, budget, pace },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202 && data.jobId) {
        await pollCloneJob(data.jobId);
        return;
      }
      // 429 等错误文案原样透传（服务端给的是配额口径的确切说法）
      setError(data.error || "克隆失败，请稍后重试");
      setBusy(false);
    } catch {
      setError("网络异常，请稍后重试");
      setBusy(false);
    }
  }

  const days = deriveDays(startAt, endAt);
  const overLimit = days !== null && days > 7; // 单城市上限；区域行程由服务端判定

  return (
    <section className="clone-cta" aria-label="一键克隆">
      {!open ? (
        <>
          <button type="button" className="clone-btn" onClick={() => setOpen(true)}>
            <Copy size={15} />
            克隆这份行程，改成我的日期
          </button>
          {/* 一句说明承诺的是机制（重新核验）而不是情绪——克隆与「改日期的
              复印件」的区别就在这句里，必须写出来 */}
          <p className="clone-note">
            换成你的出发时间与预算，按新日期重新核查闭馆与通勤后重新生成（约 2-4 分钟）
          </p>
        </>
      ) : (
        <form className="clone-form" onSubmit={onSubmit}>
          <div className="clone-row">
            <div>
              <label htmlFor="clone-start">我的出发时间</label>
              <input
                id="clone-start"
                type="datetime-local"
                value={startAt}
                onChange={(e) => setStartAt(e.target.value)}
                required
              />
            </div>
            <div>
              <label htmlFor="clone-end">我的结束时间</label>
              <input
                id="clone-end"
                type="datetime-local"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                required
              />
            </div>
          </div>
          {days !== null && (
            <p className="helper">
              共 {days} 天{overLimit ? "（超过 7 天仅区域行程支持，将被服务端拒绝）" : ""}
            </p>
          )}

          <div className="clone-row">
            <div>
              <label htmlFor="clone-budget">我的人均预算（元）</label>
              <input
                id="clone-budget"
                type="number"
                min={500}
                step={100}
                value={budget}
                onChange={(e) => setBudget(Number(e.target.value))}
                required
              />
            </div>
            <div>
              <label id="clone-pace-label">我的行程节奏</label>
              <div className="segmented" role="group" aria-labelledby="clone-pace-label">
                {PACE_OPTIONS.map(([value, label, desc]) => (
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
            </div>
          </div>

          <p className="helper">
            默认已错峰 7
            天（星期几与原行程一致）；预算按原行程预填。城市、必游地、偏好、住所、交通方式沿用原行程，不可在此修改。
          </p>

          <div className="clone-actions">
            <button type="submit" className="clone-btn" disabled={busy}>
              <Copy size={15} />
              {busy ? "克隆生成中…" : "开始克隆"}
            </button>
            <button
              type="button"
              className="clone-cancel"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              收起
            </button>
          </div>

          {busy && (
            <div className="clone-progress" role="status">
              <span className="clone-spin" aria-hidden="true" />
              <div className="clone-progress-text">
                <strong>
                  正在克隆{plan.city} {plan.days.length} 天行程
                </strong>
                <span>
                  {CLONE_TIPS[tipIndex]}
                  {stageNote ? ` · ${stageNote}` : ""} · 已等待 {elapsed} 秒
                </span>
              </div>
            </div>
          )}

          {error && (
            <div className="alert alert-error" role="alert">
              <AlertTriangle size={16} style={{ marginTop: 2 }} />
              <span>{error}</span>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
