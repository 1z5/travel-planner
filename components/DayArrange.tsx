"use client";

import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, GripVertical, Loader2, TimerReset, Undo2 } from "lucide-react";
import type { Plan, PlanDay } from "@/lib/types";

// ============================================================
// 调整镜头：直接操纵当天的点位顺序。
//
// 与「重排这天 / 一句话改」的区别：那两个是「描述意图 → 等 LLM」；这里是
// 用户自己排，服务端只做确定性重算（retimeDay：按真实路段 + 停留时长推
// 时间轴）。缺真实路段时不假装算得动——顺序照改，原因写进 notes。
//
// 交互：桌面拖左侧手柄，移动端/键盘用 ↑↓；保存是乐观的（失败回滚并说明），
// 每一步都可「撤销上一步」（= 用上一版顺序再排一次，落库生效，不是本地假撤销）。
// ============================================================

interface Props {
  shareId: string;
  day: PlanDay;
  onPlanChange: (plan: Plan) => void;
}

export function DayArrange({ shareId, day, onPlanChange }: Props) {
  const [order, setOrder] = useState<number[]>(() => day.spots.map((_, i) => i));
  const [prevOrder, setPrevOrder] = useState<number[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const [revision, setRevision] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [dragFrom, setDragFrom] = useState<number | null>(null);

  // 换天或行程被其它路径改写（refine/克隆）时，顺序重置为新数据的下标序。
  // 不在这里清 notes/error——保存成功后父组件更新 plan 会触发本 effect，
  // 一并清掉就把「刚才发生了什么」抹了。
  useEffect(() => {
    setOrder(day.spots.map((_, i) => i));
  }, [day.day, day.spots]);

  async function save(next: number[], prev: number[]) {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/plan/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, op: "reorder", day: day.day, order: next }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error ?? `重排失败（HTTP ${r.status}）`);
        setOrder(prev); // 回滚：用户看到的就是没保存成功的状态
        return;
      }
      setPrevOrder(prev);
      setNotes(Array.isArray(d.notes) ? d.notes : []);
      setRevision(typeof d.revision === "number" ? d.revision : null);
      if (d.plan) onPlanChange(d.plan);
    } catch {
      setError("网络异常，重排未保存");
      setOrder(prev);
    } finally {
      setSaving(false);
    }
  }

  function move(from: number, to: number) {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    void save(next, order);
  }

  async function retime() {
    setSaving(true);
    setError("");
    try {
      const r = await fetch("/api/plan/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, op: "retime", day: day.day }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(d.error ?? "顺延失败");
        return;
      }
      setNotes(Array.isArray(d.notes) ? d.notes : []);
      setRevision(typeof d.revision === "number" ? d.revision : null);
      if (d.plan) onPlanChange(d.plan);
    } catch {
      setError("网络异常，顺延未保存");
    } finally {
      setSaving(false);
    }
  }

  function undo() {
    if (!prevOrder) return;
    const next = prevOrder;
    setOrder(next);
    void save(next, order);
  }

  return (
    <section className="arrange" aria-label="调整当天顺序">
      <div className="arrange-head">
        <div>
          <h2 className="arrange-title">
            第 {day.day} 天 · 调整顺序
            {day.theme ? <span className="arrange-theme">{day.theme}</span> : null}
          </h2>
          <p className="arrange-hint">
            拖左侧手柄，或点 ↑↓ 调整顺序。保存时按真实路段与停留时长确定性重算时间轴——
            不调模型、不消耗生成配额。
          </p>
        </div>
        <div className="arrange-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void retime()}
            disabled={saving}
          >
            <TimerReset size={14} />
            顺延时间轴
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={undo}
            disabled={saving || !prevOrder}
          >
            <Undo2 size={14} />
            撤销上一步
          </button>
          {revision !== null && <span className="arrange-rev">已保存 · revision {revision}</span>}
        </div>
      </div>

      <ol className="arrange-list">
        {order.map((spotIdx, pos) => {
          const spot = day.spots[spotIdx];
          if (!spot) return null;
          return (
            <li
              key={`${spotIdx}-${spot.name}`}
              className={`arrange-item${dragFrom === pos ? " arrange-dragging" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", String(pos));
                setDragFrom(pos);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData("text/plain"));
                setDragFrom(null);
                move(from, pos);
              }}
            >
              <span className="arrange-grip" aria-hidden="true">
                <GripVertical size={14} />
              </span>
              <span className="arrange-pos">{pos + 1}</span>
              <span className="arrange-name">{spot.name}</span>
              <span className="arrange-time">{spot.time}</span>
              <span className="arrange-dur">
                {Number.isFinite(spot.durationMin) ? `${spot.durationMin} 分钟` : "时长未知"}
              </span>
              <span className="arrange-move">
                <button
                  type="button"
                  aria-label={`上移 ${spot.name}`}
                  disabled={saving || pos === 0}
                  onClick={() => move(pos, pos - 1)}
                >
                  <ArrowUp size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`下移 ${spot.name}`}
                  disabled={saving || pos === order.length - 1}
                  onClick={() => move(pos, pos + 1)}
                >
                  <ArrowDown size={13} />
                </button>
              </span>
            </li>
          );
        })}
      </ol>

      {saving && (
        <p className="arrange-status">
          <Loader2 size={13} className="spin" />
          正在保存并重算时间轴…
        </p>
      )}
      {error && (
        <p className="arrange-error" role="alert">
          {error}
        </p>
      )}
      {notes.length > 0 && (
        <ul className="arrange-notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
