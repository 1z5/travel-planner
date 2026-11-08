"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Copy, Download, RotateCcw } from "lucide-react";
import { PENDING_HANDOFF_TEXT_KEY } from "@/lib/pending-handoff";
import {
  applyDecision,
  applyMark,
  countByStatus,
  createReceipt,
  verifyReceipt,
} from "@/lib/handoff/receipt";
import { receiptFileName, serializeReceipt, toTextCard } from "@/lib/handoff/format";
import { HANDOFF_NOTICE, type ClaimStatus, type HandoffReceipt } from "@/lib/handoff/types";

// ============================================================
// 出发前交接台：贴原文 → 逐条签字 → 带走一张可离线复算的单子。
//
// 三条不可让步的约束（对应 research/2026-11-08-final 的最终方案）：
// 1) 全程零网络请求。切片、表态、事件链、出单都在浏览器里完成——
//    「我们不担保」不是免责条款，是架构事实：我们手里根本没有数据。
// 2) 不出判定。没有评分、没有 A–D、没有「最可能让你白跑」的排序、
//    没有一键理顺。断言默认值是 unchecked，含义是「目前没人核过」。
// 3) 断言是原文连续子串，span 精确。这里不请 LLM 理解行程，所以从结构上
//    不可能出现「上午」被编成 09:00、或凭空多出一个已核验状态。
// ============================================================

const EXAMPLE = [
  "苏州 3 天，人均预算 2000 元",
  "第 1 天",
  "09:00-11:00 拙政园，需提前预约。",
  "11:30-13:00 苏州博物馆，周一闭馆。",
  "地铁半小时能从前门到颐和园。",
  "第 2 天：上午 虎丘，下午 留园，晚上 山塘街",
  "第 3 天：09:00-11:00 狮子林，之后去赶末班缆车",
].join("\n");

type Stage = "input" | "sign" | "receipt";

interface DeskState {
  stage: Stage;
  text: string;
  receipt: HandoffReceipt | null;
  decision: string;
}

const INITIAL: DeskState = { stage: "input", text: "", receipt: null, decision: "" };

const STATUS_BUTTONS: { status: ClaimStatus; label: string }[] = [
  { status: "verified", label: "我核过" },
  { status: "changed", label: "我改了" },
  { status: "trusted", label: "先信着" },
];

export function HandoffDesk() {
  const [state, setState] = useState<DeskState>(INITIAL);
  const [basis, setBasis] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [verification, setVerification] = useState<{ ok: boolean; reason?: string } | null>(null);
  const autoRan = useRef(false);

  // 首页粘贴框把长文本暂存到 sessionStorage（不塞 URL）。读一次即清。
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    let pending = "";
    try {
      pending = window.sessionStorage.getItem(PENDING_HANDOFF_TEXT_KEY) ?? "";
      if (pending) window.sessionStorage.removeItem(PENDING_HANDOFF_TEXT_KEY);
    } catch {
      pending = "";
    }
    if (pending.trim().length < 20) return;
    const text = pending.trim();
    // 与 sessionStorage 同步后一次性初始化，不是渲染期级联 setState
    // eslint-disable-next-line react/set-state-in-effect -- 外部存储同步后的一次性初始化
    setState({ stage: "sign", text, receipt: createReceipt(text), decision: "" });
  }, []);

  function start(text: string) {
    const trimmed = text.trim();
    if (trimmed.length < 20) return;
    setState({ stage: "sign", text: trimmed, receipt: createReceipt(trimmed), decision: "" });
    setBasis({});
    setNote({});
    setVerification(null);
    setCopied(false);
  }

  function mark(claimId: string, status: ClaimStatus, current: HandoffReceipt) {
    const b = basis[claimId]?.trim();
    const n = note[claimId]?.trim();
    const next = applyMark(current, claimId, status, {
      ...(b ? { basis: b } : {}),
      ...(n ? { note: n } : {}),
    });
    setState((prev) => ({ ...prev, receipt: next }));
  }

  /** 改完依据后，用当前状态再追加一次动作（append-only，不改写历史）。 */
  function refreshAnnotation(claimId: string, current: HandoffReceipt) {
    const claim = current.claims.find((c) => c.id === claimId);
    if (!claim || claim.status === "unchecked") return;
    mark(claimId, claim.status, current);
  }

  function finish() {
    if (!state.receipt) return;
    const final = applyDecision(state.receipt, state.decision.trim());
    setState({ ...state, receipt: final, stage: "receipt" });
  }

  function reset() {
    setState(INITIAL);
    setBasis({});
    setNote({});
    setCopied(false);
    setVerification(null);
  }

  function download(receipt: HandoffReceipt) {
    const blob = new Blob([serializeReceipt(receipt)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = receiptFileName(receipt);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function copyCard(receipt: HandoffReceipt) {
    try {
      await navigator.clipboard.writeText(toTextCard(receipt));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const r = state.receipt;
  const n = r ? countByStatus(r) : null;

  return (
    <div className="ho-desk">
      <p className="ho-kicker">出发前 · 交接一次</p>
      <h1 className="ho-title">把 AI 说的，变成你自己确认过的</h1>
      <p className="ho-lede">
        手上那份行程，哪些你真核过、哪些只是先信着，出发前花一分钟说清楚。我们不替你判断、不打分、不改写，只把你的决定留成一张能带走的交接单。
      </p>

      {state.stage === "input" && (
        <section className="ho-card" aria-label="粘贴行程原文">
          <label className="ho-label" htmlFor="ho-text">
            把行程原文贴进来
          </label>
          <textarea
            id="ho-text"
            className="ho-textarea"
            value={state.text}
            onChange={(e) => setState({ ...state, text: e.target.value })}
            rows={8}
            maxLength={8000}
            placeholder="ChatGPT 写的、小红书抄的、朋友发的一段话、OTA 确认邮件……原样贴进来就行"
          />
          <div className="ho-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={state.text.trim().length < 20}
              onClick={() => start(state.text)}
            >
              摊开，我来签字 <ArrowRight size={15} aria-hidden="true" />
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => start(EXAMPLE)}>
              用一段示例试试
            </button>
          </div>
          <ul className="ho-honest">
            <li>不上传：全程在你浏览器里完成，我们不保存任何行程原文。</li>
            <li>不核验：默认每条都是「没核过」，依据由你自己填，我们不代查。</li>
            <li>不评分：没有等级、没有「帮你理顺」，决定权始终在你手上。</li>
          </ul>
        </section>
      )}

      {state.stage === "sign" && r && n && (
        <section aria-label="逐条签字">
          <div className="ho-summary" role="status" aria-live="polite">
            共 {r.claims.length} 条断言 · 核过 {n.verified} · 改了 {n.changed} · 先信着 {n.trusted}{" "}
            · 未表态 {n.unchecked}
          </div>
          {r.truncated > 0 && (
            <p className="ho-warn">另有 {r.truncated} 条因上限未纳入，已如实记进单子。</p>
          )}
          <p className="ho-hint">
            下面每条都是原文片段，我们没有补任何东西。点一下你的状态；依据和备注可填，填完离开输入框即会记入。
          </p>

          <ol className="ho-claims">
            {r.claims.map((c) => (
              <li key={c.id} className={`ho-claim ho-claim-${c.status}`}>
                <div className="ho-claim-head">
                  <span className="ho-claim-id">{c.id}</span>
                  <p className="ho-claim-text">{c.text}</p>
                </div>
                <div className="ho-claim-buttons" role="group" aria-label={`${c.id} 的表态`}>
                  {STATUS_BUTTONS.map((b) => (
                    <button
                      key={b.status}
                      type="button"
                      className="ho-chip"
                      aria-pressed={c.status === b.status}
                      onClick={() => mark(c.id, b.status, r)}
                    >
                      {c.status === b.status && <Check size={12} aria-hidden="true" />}
                      {b.label}
                    </button>
                  ))}
                </div>
                {c.status !== "unchecked" && (
                  <div className="ho-claim-fields">
                    <label>
                      <span>依据</span>
                      <input
                        type="text"
                        maxLength={120}
                        value={basis[c.id] ?? ""}
                        placeholder="官网 / 地图 / 订票页 / 问过朋友"
                        onChange={(e) => setBasis({ ...basis, [c.id]: e.target.value })}
                        onBlur={() => refreshAnnotation(c.id, r)}
                        aria-label={`${c.id} 的依据`}
                      />
                    </label>
                    <label>
                      <span>备注</span>
                      <input
                        type="text"
                        maxLength={120}
                        value={note[c.id] ?? ""}
                        placeholder="改成了什么，或为什么先信着"
                        onChange={(e) => setNote({ ...note, [c.id]: e.target.value })}
                        onBlur={() => refreshAnnotation(c.id, r)}
                        aria-label={`${c.id} 的备注`}
                      />
                    </label>
                  </div>
                )}
              </li>
            ))}
          </ol>

          <section className="ho-card ho-decision">
            <label className="ho-label" htmlFor="ho-decision">
              我这次决定怎么做
            </label>
            <textarea
              id="ho-decision"
              className="ho-textarea ho-textarea-sm"
              value={state.decision}
              onChange={(e) => setState({ ...state, decision: e.target.value })}
              rows={2}
              maxLength={300}
              placeholder="例如：先按这版走，周一晚上重新核一次闭馆。"
            />
            <div className="ho-actions">
              <button type="button" className="btn btn-primary" onClick={finish}>
                生成交接单 <ArrowRight size={15} aria-hidden="true" />
              </button>
              <button type="button" className="btn btn-ghost" onClick={reset}>
                <RotateCcw size={14} aria-hidden="true" /> 重新贴一段
              </button>
            </div>
            <p className="ho-hint">不表态也能生成，单子会如实写下「0 条核过」。</p>
          </section>
        </section>
      )}

      {state.stage === "receipt" && r && n && (
        <section aria-label="交接单">
          <div className="ho-receipt">
            <div className="ho-receipt-head">
              <span className="ho-receipt-tag">出发前交接单</span>
              <span className="ho-receipt-id">{r.id}</span>
            </div>
            <p className="ho-receipt-meta">
              生成于 {r.createdAt.replace("T", " ").slice(0, 19)}
              （设备自述时间，我们不证明这个时刻） · 原文 {r.source.chars} 字
            </p>
            <div className="ho-metrics">
              <div>
                <span>我核过</span>
                <strong>{n.verified}</strong>
              </div>
              <div>
                <span>我改了</span>
                <strong>{n.changed}</strong>
              </div>
              <div>
                <span>先信着</span>
                <strong>{n.trusted}</strong>
              </div>
              <div>
                <span>未表态</span>
                <strong>{n.unchecked}</strong>
              </div>
            </div>
            {r.decision && (
              <p className="ho-receipt-decision">
                <span>我的决定</span>
                {r.decision}
              </p>
            )}
            {r.truncated > 0 && <p className="ho-warn">另有 {r.truncated} 条因上限未纳入。</p>}
            <p className="ho-notice">{HANDOFF_NOTICE}</p>
          </div>

          <div className="ho-actions">
            <button type="button" className="btn btn-primary" onClick={() => download(r)}>
              <Download size={15} aria-hidden="true" /> 下载可复算文件
            </button>
            <button type="button" className="btn" onClick={() => void copyCard(r)}>
              <Copy size={14} aria-hidden="true" /> {copied ? "已复制" : "复制文本卡"}
            </button>
            <button type="button" className="btn" onClick={() => setVerification(verifyReceipt(r))}>
              自己复核一次
            </button>
            <button type="button" className="btn btn-ghost" onClick={reset}>
              再来一份
            </button>
          </div>
          {verification && (
            <p className={verification.ok ? "ho-verify-ok" : "ho-verify-bad"} aria-live="polite">
              {verification.ok
                ? "复核通过：每条断言都能回溯到原文，事件链与编号一致。这份 JSON 脱离我们的服务器也能被任何人重跑。"
                : `复核未通过：${verification.reason ?? "单子不完整"}`}
            </p>
          )}
          <p className="ho-hint">
            下载的 .json
            就是完整单子，含原文、断言、你的每一次表态与事件链。它不依赖我们的服务器，也不需要账号。
            需要第三方时间固化，请自行使用可信时间戳；我们不做签名、不担保。
          </p>
          <p className="ho-after">
            还想要一份「我们替你核过」的完整行程？
            <Link href="/new">去新建一份行程</Link>
            （那是另一条产品线，需要高德 key 与生成时间）。
          </p>
        </section>
      )}
    </div>
  );
}
