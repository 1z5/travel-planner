"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, MapPin, Star } from "lucide-react";
import type { Plan } from "@/lib/types";

// ============================================================
// 「多看几个」候选对比面板（产品线 S4 v0）
//
// 与「换一个」的区别：换一个是让模型重抽（结果不可比较）；这里是服务端给出
// 3 个**真实存在**的替代点（高德验真过的名称/评分/人均/营业时间 + 从上一站
// 过去的真实通勤），用户自己挑一个，服务端重新验真后确定性替换。
//
// 诚实口径：
// 1. 拿不到候选（MOCK/上游失败）时明说原因，不展示假清单；
// 2. 评分/人均/通勤缺失就整块不显示（不填默认值）；
// 3. 替换是服务端重新验真后才生效的，客户端只传「名字」。
// ============================================================

interface Candidate {
  name: string;
  area: string;
  rating?: number;
  avgCostCny?: number;
  transitMin: number | null;
  distanceFromPrevM: number | null;
}

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; candidates: Candidate[]; prevName: string | null };

export function SpotCandidates({
  shareId,
  day,
  spotIndex,
  currentName,
  onApplied,
  onClose,
}: {
  shareId: string;
  day: number;
  spotIndex: number;
  currentName: string;
  onApplied: (plan: Plan, revision: number | null) => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/plan/candidates?shareId=${encodeURIComponent(shareId)}&day=${day}&spotIndex=${spotIndex}`,
        );
        const d = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setState({ status: "error", message: d.error || "候选查询失败，请稍后重试" });
          return;
        }
        setState({
          status: "done",
          candidates: Array.isArray(d.candidates) ? d.candidates : [],
          prevName: typeof d.prevName === "string" ? d.prevName : null,
        });
      } catch {
        if (!cancelled) setState({ status: "error", message: "网络异常，候选查询失败" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareId, day, spotIndex]);

  async function applyCandidate(name: string) {
    setApplying(name);
    setError("");
    try {
      const r = await fetch("/api/plan/candidates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, day, spotIndex, name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error || "替换失败，请稍后重试");
        return;
      }
      if (d.plan) onApplied(d.plan, typeof d.revision === "number" ? d.revision : null);
      onClose();
    } catch {
      setError("网络异常，替换未保存，请重试");
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="spot-candidates" role="region" aria-label={`${currentName} 的替代候选`}>
      <div className="spot-candidates-head">
        <span className="spot-candidates-title">多看几个 · 真实候选</span>
        <button type="button" className="btn-link" onClick={onClose} aria-label="收起候选">
          收起
        </button>
      </div>

      {state.status === "loading" && (
        <p className="spot-candidates-hint" role="status">
          <Loader2 size={13} className="spin" aria-hidden="true" />
          正在按你的交通方式核验候选…
        </p>
      )}

      {state.status === "error" && (
        <p className="spot-candidates-hint" role="status">
          <AlertTriangle size={13} aria-hidden="true" />
          {state.message}
        </p>
      )}

      {state.status === "done" && state.candidates.length === 0 && (
        <p className="spot-candidates-hint" role="status">
          周边没有找到可替换的真实候选（不猜，不拿相似名字凑数）。
        </p>
      )}

      {state.status === "done" && state.candidates.length > 0 && (
        <>
          <p className="spot-candidates-hint">
            以下候选均通过高德验真
            {state.prevName ? `；通勤从「${state.prevName}」算起` : ""}
            。点「换成这个」后整条行程会重新体检。
          </p>
          <ul className="spot-candidates-list">
            {state.candidates.map((c) => (
              <li key={c.name} className="spot-candidate">
                <div className="spot-candidate-main">
                  <strong className="spot-candidate-name">{c.name}</strong>
                  <span className="spot-candidate-meta">
                    {c.area}
                    {c.rating !== undefined && (
                      <>
                        {" · "}
                        <Star size={10} aria-hidden="true" /> {c.rating.toFixed(1)}
                      </>
                    )}
                    {c.avgCostCny !== undefined && ` · 人均 ¥${c.avgCostCny}`}
                    {c.transitMin !== null && ` · 通勤约 ${c.transitMin} 分钟`}
                    {c.transitMin === null && c.distanceFromPrevM !== null && (
                      <> · 直线 {Math.round(c.distanceFromPrevM / 100) / 10} 公里（通勤未知）</>
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={applying !== null}
                  onClick={() => void applyCandidate(c.name)}
                  aria-label={`把${currentName}换成${c.name}`}
                >
                  {applying === c.name ? (
                    <>
                      <Loader2 size={12} className="spin" aria-hidden="true" />
                      替换中…
                    </>
                  ) : (
                    <>
                      <MapPin size={12} aria-hidden="true" />
                      换成这个
                    </>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p className="spot-candidates-error" role="status">
          {error}
        </p>
      )}
    </div>
  );
}
