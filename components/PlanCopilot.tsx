"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Loader2, Send, Sparkles, Trash2, Wand2 } from "lucide-react";
import type { CopilotAnswer, CopilotMsg, CopilotSuggestion } from "@/lib/copilot-types";

// ============================================================
// 「行程管家」对话卡：在行程页里针对**当前这份行程**提问。
//
// 组件只负责交互与请求契约（POST /api/plan/chat），答案与建议都由服务端
// 结合行程数据生成。三条产品红线落在代码里：
// 1. 不假装成功：非 2xx 直接展示服务端 error，网络异常明确说「网络异常」；
// 2. 不自动改行程：服务端只给 suggestion，必须用户再点一次才交给 onSuggestion；
// 3. 同一时刻只发一个请求：等待期禁用输入/按钮，并用 ref 兜住同一 tick 的连点。
// ============================================================

/** 请求窗口：只带最近 8 条，控制 token 也让上下文聚焦当前话题（契约上限 12） */
const HISTORY_LIMIT = 8;
/** 单条消息上限（与后端契约一致） */
const MAX_MESSAGE_CHARS = 500;

const RECOMMENDED_QUESTIONS = [
  "第二天来得及吗",
  "下雨怎么调整",
  "预算花在哪了",
  "附近吃什么",
  "哪天会闭馆",
  "这趟会不会太赶",
] as const;

const FIX_KINDS = ["transit", "pace", "budget-over", "budget-under", "rain", "hours"] as const;

type SuggestionState = "idle" | "pending" | "done";

interface UiMessage extends CopilotMsg {
  id: number;
  suggestion?: CopilotSuggestion;
  suggestionState?: SuggestionState;
}

export interface PlanCopilotProps {
  shareId: string;
  onSuggestion?: (s: CopilotSuggestion) => void | Promise<void>;
}

/** 建议按钮的说明文案：label 后面的补充，说清「点一下会发生什么」 */
function suggestionHint(s: CopilotSuggestion): string {
  if (s.kind === "retime") return `第 ${s.day} 天 · 点一下按真实时长顺延`;
  return `第 ${s.day} 天 · 点一下交给行程修改`;
}

/** 成功响应里只认契约内的字段；畸形 suggestion 忽略，不让 UI 崩在 label 上 */
function parseSuggestion(value: unknown): CopilotSuggestion | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.label !== "string" || v.label.trim() === "") return undefined;
  if (typeof v.day !== "number" || !Number.isInteger(v.day) || v.day < 1) return undefined;
  if (v.kind === "retime") {
    return { kind: "retime", day: v.day, label: v.label };
  }
  if (
    v.kind === "fix"
    && typeof v.fixKind === "string"
    && (FIX_KINDS as readonly string[]).includes(v.fixKind)
  ) {
    return {
      kind: "fix",
      fixKind: v.fixKind as Extract<CopilotSuggestion, { kind: "fix" }>["fixKind"],
      day: v.day,
      label: v.label,
    };
  }
  return undefined;
}

/** 错误 body 形状是 { error }；拿不到就返回空串，由调用方给兜底文案 */
function serverErrorText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as Record<string, unknown>).error;
  return typeof error === "string" ? error.trim() : "";
}

export function PlanCopilot({ shareId, onSuggestion }: PlanCopilotProps) {
  const [expanded, setExpanded] = useState(true);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState("");
  const [suggestionError, setSuggestionError] = useState("");

  const nextIdRef = useRef(1);
  const inFlightRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);
  const bodyId = useId();

  // 等待计时：step-5 一次通常 10-40 秒，用户需要知道「还在动」而不是卡死。
  // 只在 loading 期间跑，卸载/结束时清掉，不泄漏 interval。
  useEffect(() => {
    if (!loading) return;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  // 新消息/等待提示出现后滚到最新——jsdom 也支持直接赋值 scrollTop
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, loading]);

  async function send(raw: string) {
    const text = raw.trim().slice(0, MAX_MESSAGE_CHARS);
    // inFlightRef 兜住「React 还没重渲染就点了第二下」的窗口：同一时刻只发一个请求
    if (!text || inFlightRef.current) return;

    const userMsg: UiMessage = {
      id: nextIdRef.current++,
      role: "user",
      content: text,
    };
    // 历史只保留最近 8 条，且最后一条必须是刚发出的 user（契约要求）
    const history: CopilotMsg[] = [...messages, userMsg]
      .slice(-HISTORY_LIMIT)
      .map((m) => ({ role: m.role, content: m.content }));

    inFlightRef.current = true;
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setError("");
    setSuggestionError("");
    setElapsedSec(0);
    setLoading(true);

    try {
      const res = await fetch("/api/plan/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, messages: history }),
      });

      // 错误 body 也可能不是 JSON：解析失败不能把真实 HTTP 状态一起吞掉
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }

      if (!res.ok) {
        // 服务端文案是给用户看的（限流/行程不存在/模型失败），直接展示，不替换成笼统提示
        setError(serverErrorText(payload) || `请求失败（HTTP ${res.status}），请重试`);
        return;
      }

      const data = (payload ?? {}) as Partial<CopilotAnswer>;
      const answer = typeof data.answer === "string" ? data.answer : "";
      if (answer.trim() === "") {
        setError("服务端返回内容为空，请重试");
        return;
      }

      const suggestion = parseSuggestion(data.suggestion);
      setMessages((prev) => [
        ...prev,
        {
          id: nextIdRef.current++,
          role: "assistant",
          content: answer,
          ...(suggestion ? { suggestion, suggestionState: "idle" as const } : {}),
        },
      ]);
    } catch {
      // fetch 本身抛错（断网/DNS/超时）——明确告诉用户可以重试
      setError("网络异常，请重试");
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }

  async function applySuggestion(messageId: number, suggestion: CopilotSuggestion) {
    if (!onSuggestion) return;
    setSuggestionError("");
    setMessages((prev) => prev.map((m) => (
      m.id === messageId ? { ...m, suggestionState: "pending" } : m
    )));
    try {
      await onSuggestion(suggestion);
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, suggestionState: "done" } : m
      )));
    } catch {
      // 交给外层执行失败：恢复可点，并如实报错，不显示「已交给」
      setMessages((prev) => prev.map((m) => (
        m.id === messageId ? { ...m, suggestionState: "idle" } : m
      )));
      setSuggestionError("交给行程修改失败，请重试");
    }
  }

  function clearConversation() {
    if (inFlightRef.current) return;
    setMessages([]);
    setInput("");
    setError("");
    setSuggestionError("");
  }

  const canSend = !loading && input.trim().length > 0;
  const canClear = !loading && messages.length > 0;

  return (
    <section className="copilot" aria-label="行程管家" data-loading={loading ? "true" : undefined}>
      <header className="copilot-head">
        <div className="copilot-heading">
          <h2 className="copilot-title">
            <Sparkles size={16} className="copilot-title-icon" aria-hidden="true" />
            行程管家
          </h2>
          <p className="copilot-sub">基于这份行程回答（step-5）</p>
        </div>
        <div className="copilot-head-actions">
          <button
            type="button"
            className="copilot-clear"
            onClick={clearConversation}
            disabled={!canClear}
          >
            <Trash2 size={13} aria-hidden="true" />
            清空对话
          </button>
          <button
            type="button"
            className="copilot-toggle"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "收起" : "展开"}
            <ChevronDown
              size={14}
              className={`copilot-chevron${expanded ? " copilot-chevron-up" : ""}`}
              aria-hidden="true"
            />
          </button>
        </div>
      </header>

      {expanded && (
        <div className="copilot-body" id={bodyId}>
          {messages.length === 0 && (
            <div className="copilot-empty">
              <p className="copilot-empty-text">关于这份行程，你可以先问：</p>
              <div className="copilot-chips">
                {RECOMMENDED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    className="copilot-chip"
                    disabled={loading}
                    onClick={() => void send(q)}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div
            className="copilot-log"
            role="log"
            aria-live="polite"
            aria-label="行程管家对话"
            aria-busy={loading}
            ref={logRef}
          >
            {messages.map((m) => {
              const state = m.suggestionState ?? "idle";
              const hasHandler = typeof onSuggestion === "function";
              return (
                <div key={m.id} className={`copilot-msg copilot-msg-${m.role}`}>
                  <span className="copilot-msg-role">
                    {m.role === "user" ? "你" : "行程管家"}
                  </span>
                  {/* 纯文本渲染：服务端答案是文本，绝不能当 HTML 注入 */}
                  <p className="copilot-msg-text">{m.content}</p>
                  {m.suggestion && (
                    <button
                      type="button"
                      className={`copilot-suggestion${state === "done" ? " copilot-suggestion-done" : ""}`}
                      disabled={!hasHandler || state === "pending" || state === "done"}
                      title={!hasHandler ? "当前页面未接入行程修改，建议暂不可执行" : undefined}
                      onClick={() => void applySuggestion(m.id, m.suggestion as CopilotSuggestion)}
                    >
                      {state === "done" ? (
                        "已交给行程修改"
                      ) : state === "pending" ? (
                        <>
                          <Loader2 size={14} className="copilot-spin" aria-hidden="true" />
                          正在交给行程修改…
                        </>
                      ) : (
                        <>
                          <Wand2 size={14} aria-hidden="true" />
                          <span className="copilot-suggestion-label">{m.suggestion.label}</span>
                          <span className="copilot-suggestion-hint">
                            {suggestionHint(m.suggestion)}
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              );
            })}

            {loading && (
              <p className="copilot-wait" role="status">
                <Loader2 size={14} className="copilot-spin" aria-hidden="true" />
                <span>正在结合你的行程思考…</span>
                <span className="copilot-wait-time">已等待 {elapsedSec} 秒</span>
                <span className="copilot-wait-hint">通常 10–40 秒</span>
              </p>
            )}
          </div>

          {error && <p className="copilot-error" role="alert">{error}</p>}
          {suggestionError && <p className="copilot-error" role="alert">{suggestionError}</p>}

          <form
            className="copilot-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              className="copilot-input"
              aria-label="向行程管家提问"
              placeholder="问日程、预算、天气、闭馆、体力、交通…"
              rows={2}
              maxLength={MAX_MESSAGE_CHARS}
              value={input}
              disabled={loading}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                // Enter 发送；Shift+Enter 不处理（textarea 默认为换行）；输入法组合中的 Enter 不发送
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <button type="submit" className="copilot-send" disabled={!canSend}>
              {loading ? (
                <Loader2 size={14} className="copilot-spin" aria-hidden="true" />
              ) : (
                <Send size={14} aria-hidden="true" />
              )}
              {loading ? "发送中…" : "发送"}
            </button>
          </form>

          <p className="copilot-foot">
            回答只基于这份行程与高德真实数据；涉及修改会给你一个具体建议，确认后才执行。
          </p>
        </div>
      )}
    </section>
  );
}
