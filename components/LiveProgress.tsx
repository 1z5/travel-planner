"use client";

// 生成等待期的「流式生长」体验（切片5 · 第一印象革命）：
// 把 3-5 分钟的轮询黑盒变成「看着行程长出来」。
//
// 三段结构：
//   1. 管线阶段清单——服务端在管线真实节点写入的 stage（见 lib/jobs.ts），
//      到达的节点打勾、当前节点动画。**不是**按时间轮换的泛化提示：
//      阶段是真实位置，撒谎比没有更糟。
//   2. 进度条——流式路径（≥5 天）有真实 N/M 天，画确定性进度；单次路径
//      （≤4 天）只有即时草稿（draft 标记），草稿天数不是生成天数，只画
//      不确定动画条。复用 WaitProgress 的骨架与文案口径。
//   3. 已生成的天逐张「生长」上屏——plan.days 每多一天就多一张卡，
//      与最终 PlanView 视觉一致（同族 day-head/day-num/day-theme），
//      并标注真实验真状态（MOCK 模式不谎称已核验）。
//
// 无 stage 遥测（旧任务/多实例落到非执行节点）时整块降级为 WaitProgress
// 骨架 + 沿用首页原有的轮换提示——宁可回到泛化提示，也不编一个阶段。

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Check, Loader2 } from "lucide-react";
import { WaitProgress } from "./WaitProgress";
import type { Plan } from "@/lib/types";

// 与 lib/jobs.ts 的 JobStage 一一对应（jobs.ts 是 server-only，客户端不能
// import，两端各存一份同口径枚举——改动必须同步，这里钉死契约）：
//   outline → grounding → day:N/M → finalizing（≥5 天流式路径）
//   grounding → generating → verify → finalizing（≤4 天单次路径）
// 节点顺序即管线真实顺序（流式路径先大纲后取事实——写反会让打勾撒谎）。

interface StageNode {
  key: string; // 与 stage 值对应（day:N/M 归一到 "day"）
  label: string;
  hint: string; // 当前节点的说明（只有激活的节点显示）
}

const STREAM_NODES: StageNode[] = [
  { key: "outline", label: "大纲成形", hint: "先定下每天的主题与区域" },
  { key: "grounding", label: "取事实", hint: "高德取真实 POI、营业时间与闭馆日" },
  { key: "day", label: "逐日生成", hint: "每天生成并逐点核验，完成一张上屏一张" },
  { key: "finalizing", label: "收尾", hint: "汇总体检、天气与预算" },
];

const SINGLE_NODES: StageNode[] = [
  { key: "grounding", label: "取事实", hint: "高德取真实 POI、营业时间与闭馆日" },
  { key: "generating", label: "生成行程", hint: "推理模型推演预算、动线与节奏（通常 2-4 分钟）" },
  { key: "verify", label: "逐点核验", hint: "POI 真实性 + 通勤 + 时间轴体检" },
  { key: "finalizing", label: "收尾", hint: "汇总体检、天气与预算" },
];

/** 无遥测兜底提示：沿用首页原有轮换文案（口径与 WaitProgress 时代一致） */
const FALLBACK_TIPS = [
  "推理模型正在推演预算、动线与节奏约束…",
  "正在展开每天的时刻表（POI / 时长 / 雨天备选）…",
  "即将核查 POI 真实性与站点间通勤…",
  "最后跑一遍体检：绕路、节奏、预算…",
];

/** 解析 day:N/M（N=已发布天数，M=总天数）；非逐日阶段返回 null */
function parseDayStage(stage: string): { n: number; m: number } | null {
  const m = /^day:(\d+)\/(\d+)$/.exec(stage);
  return m ? { n: Number(m[1]), m: Number(m[2]) } : null;
}

/** stage → 节点 key（day:N/M 归一到 "day"） */
function stageKey(stage: string): string {
  return stage.startsWith("day:") ? "day" : stage;
}

/**
 * 验真状态徽章（真实状态，不猜）：
 * - pending：当天已过 validateDay 的逐点验真（发布前的必经步骤），全局收尾未完成
 * - mock：MOCK 模式没走高德，明说「未逐点验真」——不拿 pending 冒充已核验
 * - ok/partial：收尾后（一般已 done，本组件不再渲染，兜底保留）
 */
function verifyBadge(verification: Plan["verification"]): string | null {
  switch (verification) {
    case "pending":
      return "已逐点核验";
    case "mock":
      return "MOCK 模式 · 未逐点验真";
    case "ok":
      return "已核验";
    case "partial":
      return "部分地点未能验真";
    default:
      return null; // 旧数据没有 verification 字段：不猜，不出徽章
  }
}

export function LiveProgress({
  stage,
  plan,
  submittedDays,
  elapsed,
}: {
  /** 管线阶段（服务端遥测；undefined = 旧任务/无遥测 → 降级） */
  stage?: string;
  /** 轮询到的增量 plan（流式路径的已生成天数 / 单次路径的即时草稿） */
  plan?: Plan | null;
  /** 本次提交的总天数（流式路径的确定性进度分母） */
  submittedDays?: number | null;
  /** 已等待时长，如 "2:30"（秒表由首页维护，口径与 WaitProgress 一致） */
  elapsed: string;
}) {
  // 无遥测：整块降级为 WaitProgress 骨架 + 轮换提示
  if (!stage)
    return <FallbackProgress plan={plan} submittedDays={submittedDays} elapsed={elapsed} />;

  // 路径判定（决定节点清单与确定性/不确定进度）：
  // - day:N/M、outline 阶段只出现在流式路径
  // - 单次路径的即时草稿带 draft 标记；流式骨架不带——plan 存在且非草稿即流式
  const isStreaming =
    stage.startsWith("day:") ||
    stage === "outline" ||
    (submittedDays != null && submittedDays >= 5) ||
    (plan != null && plan.draft !== true);
  const nodes = isStreaming ? STREAM_NODES : SINGLE_NODES;
  const current = Math.max(
    0,
    nodes.findIndex((n) => n.key === stageKey(stage)),
  );
  const day = parseDayStage(stage);

  // 确定性进度只给流式路径：分母 M 优先取 stage 里的管线口径（大纲真实
  // 天数），没有 day 阶段时（大纲/取事实中）退回用户提交的天数。
  // 单次路径 pct=null → 不确定动画条（草稿天数不是生成天数，不假装百分比）。
  const total = day?.m ?? submittedDays ?? null;
  const pct =
    isStreaming && total
      ? Math.min(100, Math.round(((plan?.days.length ?? 0) / total) * 100))
      : null;
  // 文案口径与旧首页一致：流式报真实 N/M 天；单次路径的等待沿用
  // 「正在生成精确行程…」（草稿存在时）——确定性进度归阶段清单，这里只补meta
  const detail =
    isStreaming && total
      ? `已生成 ${plan?.days.length ?? 0}/${total} 天`
      : plan?.draft
        ? "正在生成精确行程…"
        : undefined;
  const dayBadge = plan ? verifyBadge(plan.verification) : null;

  return (
    <div className="live-progress">
      {/* 管线阶段清单：到达打勾、当前动画、之后待办 */}
      <ol className="live-stages">
        {nodes.map((n, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <li
              key={n.key}
              className={`live-stage${done ? " done" : ""}${active ? " active" : ""}`}
            >
              <span className="live-stage-dot" aria-hidden="true">
                {done ? (
                  <Check size={13} />
                ) : active ? (
                  <Loader2 size={13} className="spin" />
                ) : null}
              </span>
              <span className="live-stage-label">{n.label}</span>
              {active && n.key === "day" && day && (
                <span className="live-stage-badge">
                  {day.n}/{day.m} 天
                </span>
              )}
              {active && n.hint && <span className="live-stage-hint">{n.hint}</span>}
            </li>
          );
        })}
      </ol>

      <WaitProgress pct={pct} elapsed={elapsed} detail={detail} />

      {/* 已生成的天逐张生长上屏（流式路径）。单次路径的草稿由结果区渲染，
          不在这里重复——草稿不是生成结果，混进来会让「已生成」失真。 */}
      {isStreaming && plan && plan.days.length > 0 && (
        <div className="live-days">
          {plan.days.map((d, i) => (
            <motion.div
              key={d.day}
              className="card live-day"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: Math.min(i * 0.06, 0.3) }}
            >
              <div className="day-head">
                <div className="day-num live-day-num">
                  <small>DAY</small>
                  {d.day}
                </div>
                <span className="day-theme">{d.theme}</span>
                {dayBadge && <span className="live-day-badge">{dayBadge}</span>}
              </div>
              <ul className="live-day-spots">
                {d.spots.slice(0, 5).map((s, j) => (
                  <li key={j}>
                    <span className="live-day-time">{s.time.split("-")[0]}</span>
                    <span className="live-day-name">{s.name}</span>
                  </li>
                ))}
                {d.spots.length > 5 && (
                  <li className="live-day-more">还有 {d.spots.length - 5} 站…</li>
                )}
              </ul>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

// 无遥测兜底：WaitProgress 骨架（不确定/确定性条沿用原首页口径）+
// 轮换提示。旧任务（部署升级前创建的）没有 stage——宁可回到泛化提示，
// 也不编一个阶段假装知道管线在哪。
function FallbackProgress({
  plan,
  submittedDays,
  elapsed,
}: {
  plan?: Plan | null;
  submittedDays?: number | null;
  elapsed: string;
}) {
  const [tip, setTip] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTip((i) => (i + 1) % FALLBACK_TIPS.length), 4500);
    return () => clearInterval(t);
  }, []);
  // 与旧首页同口径：非草稿（流式）且有真实天数才画确定性宽度
  const days = plan?.days.length ?? 0;
  const pct =
    plan && plan.draft !== true && submittedDays && days > 0
      ? Math.min(100, Math.round((days / submittedDays) * 100))
      : null;
  return (
    <>
      <WaitProgress
        pct={pct}
        elapsed={elapsed}
        detail={pct !== null ? `已生成 ${days}/${submittedDays} 天` : undefined}
      />
      <p className="muted" role="status" style={{ marginTop: 8 }}>
        {FALLBACK_TIPS[tip]}
      </p>
    </>
  );
}
