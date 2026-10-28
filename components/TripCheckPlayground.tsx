"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, FileJson, Info, Loader2, Play, Share2, Trash2 } from "lucide-react";
import { TRIP_CHECK_SAMPLES, type TripCheckSample } from "@/lib/verify/samples";
import type { TripCheckOptions, TripCheckReport as TripCheckReportData } from "@/lib/verify/types";
import { TripCheckReport, type TripCheckRepairResponse } from "@/components/TripCheckReport";

// ============================================================
// Trip Check 公开体验台（客户端）
//
// 三条设计约束：
// 1) 只负责「收集输入 + 调公开 API + 展示结果」，判定逻辑一行都不在前端——
//    开放标准要求浏览器/第三方/服务端跑的是同一份确定性引擎（lib/verify/）。
// 2) 错误必须说到点上：400 的 errors[].path 逐条列出（提交前 JSON 语法错误
//    在本地拦下，不浪费一次请求）；404/413/429/网络错误各有可操作文案。
// 3) 空输入不发请求；加载态不假装进度；有结果时明确「按文档数据」而非「真实可行」。
//
// ?share= 由服务端页面读 searchParams 后作为 initialShareId 传入，挂载后自动体检一次。
// ============================================================

type Mode = "document" | "share";
type Pace = "" | NonNullable<TripCheckOptions["pace"]>;

interface PlaygroundError {
  title: string;
  message?: string;
  /** 服务端字段级错误（400 的 errors[].path） */
  items?: { path: string; message: string }[];
}

type SubmitInput = { mode: "document"; json?: string } | { mode: "share"; shareId?: string };

/** 与 app/api/verify 的 body 上限一致（256 KiB），提前提示而不是让用户吃 413 */
const MAX_BODY_BYTES = 256 * 1024;

const PACE_OPTIONS: { value: Pace; label: string }[] = [
  { value: "", label: "默认口径（适中）" },
  { value: "relaxed", label: "轻松" },
  { value: "balanced", label: "适中（显式）" },
  { value: "packed", label: "紧凑" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReport(value: unknown): value is TripCheckReportData {
  if (!isRecord(value) || !isRecord(value.verdict)) return false;
  return isRecord(value.verdict.consistency) && isRecord(value.verdict.facts);
}

/** 修复响应守卫：形状不对就明确报错，不把半截数据渲染成「修好了」 */
function isRepairResponse(value: unknown): value is TripCheckRepairResponse {
  if (!isRecord(value)) return false;
  if (!isRecord(value.document) || !isRecord(value.delta)) return false;
  if (!isReport(value.before) || !isReport(value.after)) return false;
  if (!Array.isArray(value.applied) || !Array.isArray(value.unrepairable)) return false;
  if (!Array.isArray(value.remainingRuleIds)) return false;
  if (typeof value.changed !== "boolean") return false;
  if (!isRecord(value.parentCredential) || !isRecord(value.credential)) return false;
  return true;
}

function utf8Bytes(text: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  // 极老环境兜底：按 UTF-8 最坏情况估算，宁可提前提示也不要让请求被 413 打回
  return text.length * 3;
}

/** HTTP 错误 → 可操作文案（400 保留字段级 path）；action 只影响兜底句的措辞 */
async function httpErrorOf(
  res: Response,
  action: "verify" | "repair" = "verify",
): Promise<PlaygroundError> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const data = isRecord(payload) ? payload : {};
  const apiError = typeof data.error === "string" ? data.error : "";
  const items = Array.isArray(data.errors)
    ? data.errors.filter(
        (item): item is { path: string; message: string } =>
          isRecord(item) && typeof item.path === "string" && typeof item.message === "string",
      )
    : [];

  if (res.status === 400) {
    if (apiError === "invalid_json") {
      return {
        title: "请求体不是合法 JSON（400）",
        message:
          typeof data.message === "string"
            ? data.message
            : "服务端无法解析请求体——请检查 JSON 语法后重试。",
      };
    }
    return {
      title: "请求不合法（400）",
      message: "服务端校验没通过。下面逐条列出出问题的字段（path 是 JSON 里的位置）：",
      items,
    };
  }
  if (res.status === 404) {
    return {
      title: "没找到这份分享行程（404）",
      message:
        "shareId 不存在或行程已过期。分享 ID 要从分享页地址（/p/ 后面）取；只在这台设备/这套部署里持久化过的行程才能被体检。",
    };
  }
  if (res.status === 413) {
    return {
      title: "文档太大（413）",
      message: "请求体上限 256 KiB。删减点位，或改用分享 ID（只提交一个 ID，不上传整份文档）。",
    };
  }
  if (res.status === 429) {
    const limit = typeof data.limit === "number" ? `（每小时 ${data.limit} 次）` : "";
    return {
      title: "请求太频繁（429）",
      message: `公开体验台的防滥用限流${limit}。等一会儿再试——这不是你的文档有问题。`,
    };
  }
  return {
    title: `服务端返回 HTTP ${res.status}`,
    message: `这次${action === "repair" ? "修复" : "体检"}没有完成，请稍后重试。`,
  };
}

export function TripCheckPlayground({ initialShareId }: { initialShareId?: string }) {
  // 带 ?share= 打开时直接进「分享 ID」模式并把输入框填好，挂载后自动体检一次
  const [mode, setMode] = useState<Mode>(initialShareId ? "share" : "document");
  const [jsonText, setJsonText] = useState("");
  const [shareId, setShareId] = useState(initialShareId ?? "");
  const [pace, setPace] = useState<Pace>("");
  const [sampleId, setSampleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState<TripCheckReportData | null>(null);
  const [error, setError] = useState<PlaygroundError | null>(null);
  // 修复结果与体检报告分开管理：修复是一份派生结果，重新体检/换输入都要整体作废
  const [repairResult, setRepairResult] = useState<TripCheckRepairResponse | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<PlaygroundError | null>(null);
  const loadingRef = useRef(false);
  const repairingRef = useRef(false);
  const autoRanRef = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  // 修复必须沿用「产出当前报告的那份输入」：document 用原始 JSON、shareId 用同一个 ID
  const lastBodyRef = useRef<Record<string, unknown> | null>(null);

  const jsonBytes = useMemo(() => utf8Bytes(jsonText), [jsonText]);
  const tooLarge = jsonBytes > MAX_BODY_BYTES;
  // 体检/修复互斥：两者共用同一份输入，任一在飞行中都不允许改输入或重发，
  // 避免「修复结果回来时输入已经换了」的竞态（旧修复结果不能贴到新报告上）
  const busy = loading || repairing;

  /** 报告/修复一起作废：旧结论不能看起来像新输入的结论 */
  const clearOutcome = useCallback(() => {
    setReport(null);
    setRepairResult(null);
    setRepairError(null);
  }, []);

  const submit = useCallback(
    async (input: SubmitInput) => {
      if (loadingRef.current) return;
      setError(null);
      clearOutcome();

      // 提交前先拦下「空输入 / 非法 JSON」——不浪费一次请求，也不把本地语法错误
      // 伪装成服务端 400（用户会以为是接口坏了）
      let body: Record<string, unknown>;
      if (input.mode === "document") {
        const raw = (input.json ?? "").trim();
        if (!raw) {
          setError({
            title: "还没有行程内容",
            message: "先载入一份示例，或把 Trip Check v0.1 的行程 JSON 粘贴到上面的文本框。",
          });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          setError({
            title: "JSON 解析失败",
            message:
              "这段内容不是合法 JSON：检查引号、逗号、括号是否成对；也可以先点一份示例看格式。",
          });
          return;
        }
        body = { document: parsed };
      } else {
        const id = (input.shareId ?? "").trim();
        if (!id) {
          setError({
            title: "还没有分享行程 ID",
            message: "填入分享页地址里 share_ 开头的那段 ID，或切回「粘贴 JSON」。",
          });
          return;
        }
        body = { shareId: id };
      }
      if (pace) body.options = { pace };

      loadingRef.current = true;
      setLoading(true);
      try {
        const res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(await httpErrorOf(res));
          return;
        }
        const data = (await res.json()) as unknown;
        if (!isReport(data)) {
          setError({
            title: "响应格式不符合约定",
            message:
              "服务端返回的不是 Trip Check 报告。请重试；若持续出现，检查 /api/verify 是否已部署。",
          });
          return;
        }
        // 记住这份输入，修复时原样复用（不重新解析 textarea，避免与报告输入不一致）
        lastBodyRef.current = body;
        setReport(data);
        // 把焦点移到结果区，键盘/读屏用户不用再猜报告出现在哪
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resultRef.current?.focus());
        }
      } catch {
        setError({
          title: "网络错误：没收到响应",
          message: "请检查网络后重试；如果 API 没启动或被代理拦截，/api/verify 也会不可用。",
        });
      } finally {
        loadingRef.current = false;
        setLoading(false);
      }
    },
    [pace, clearOutcome],
  );

  // ?share= 自动体检一次；autoRanRef 保证 StrictMode 双执行 / 口径切换不会重复请求
  useEffect(() => {
    if (!initialShareId || autoRanRef.current) return;
    autoRanRef.current = true;
    void submit({ mode: "share", shareId: initialShareId });
  }, [initialShareId, submit]);

  /**
   * 确定性修复：用「产出当前报告的那份输入」再 POST 一次 /api/verify/repair。
   * 修复结果不写回输入框、也不替换报告——它是一份可复制/下载的建议，用户自己决定是否采用。
   */
  const runRepair = useCallback(async () => {
    if (repairingRef.current || loadingRef.current) return;
    const body = lastBodyRef.current;
    if (!body) {
      setRepairError({
        title: "还没有可以修复的体检报告",
        message: "先完成一次体检；修复会沿用同一份输入与判定口径。",
      });
      return;
    }
    repairingRef.current = true;
    setRepairing(true);
    setRepairError(null);
    setRepairResult(null);
    try {
      const res = await fetch("/api/verify/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setRepairError(await httpErrorOf(res, "repair"));
        return;
      }
      const data = (await res.json()) as unknown;
      if (!isRepairResponse(data)) {
        setRepairError({
          title: "响应格式不符合约定",
          message:
            "服务端返回的不是修复结果。请重试；若持续出现，检查 /api/verify/repair 是否已部署。",
        });
        return;
      }
      setRepairResult(data);
    } catch {
      setRepairError({
        title: "网络错误：没收到响应",
        message: "修复请求没有收到响应，请检查网络后重试；当前体检报告不受影响。",
      });
    } finally {
      repairingRef.current = false;
      setRepairing(false);
    }
  }, []);

  function loadSample(sample: TripCheckSample) {
    setMode("document");
    setJsonText(JSON.stringify(sample.document, null, 2));
    setSampleId(sample.id);
    setError(null);
    // 旧结论对应的是旧输入：换输入必须清掉，否则看起来像新输入的体检结果
    clearOutcome();
  }

  function clearAll() {
    setJsonText("");
    setShareId("");
    setSampleId(null);
    setError(null);
    clearOutcome();
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    clearOutcome();
  }

  return (
    <section className="tc-playground" aria-labelledby="tc-playground-title" aria-busy={busy}>
      <div className="tc-panel card">
        <div className="card-body">
          <div className="tc-panel-head">
            <h2 className="tc-panel-title" id="tc-playground-title">
              粘贴一份行程，拿到两轴体检报告
            </h2>
            <p className="tc-panel-sub">
              不用登录、不上传文件：JSON 只用于这一次确定性判定（服务端不落库）。不调模型，
              同一份输入任何人都能复算出同一个结论。
            </p>
          </div>

          <div className="tc-mode-block">
            <p className="tc-label">输入方式</p>
            <div className="tc-segmented" role="group" aria-label="输入方式">
              <button
                type="button"
                className={`btn tc-seg-btn${mode === "document" ? " tc-seg-active" : ""}`}
                aria-pressed={mode === "document"}
                onClick={() => switchMode("document")}
                disabled={busy}
              >
                <FileJson size={15} aria-hidden="true" />
                粘贴 JSON
              </button>
              <button
                type="button"
                className={`btn tc-seg-btn${mode === "share" ? " tc-seg-active" : ""}`}
                aria-pressed={mode === "share"}
                onClick={() => switchMode("share")}
                disabled={busy}
              >
                <Share2 size={15} aria-hidden="true" />
                分享 ID
              </button>
            </div>
          </div>

          {mode === "document" ? (
            <>
              <div className="tc-samples-block">
                <p className="tc-label">没有现成的 JSON？用示例开始</p>
                <ul className="tc-samples">
                  {TRIP_CHECK_SAMPLES.map((sample) => (
                    <li key={sample.id} className="tc-sample-item">
                      <button
                        type="button"
                        className={`tc-sample${sampleId === sample.id ? " tc-sample-active" : ""}`}
                        aria-pressed={sampleId === sample.id}
                        onClick={() => loadSample(sample)}
                        disabled={busy}
                      >
                        <span className="tc-sample-label">{sample.label}</span>
                        <span className="tc-sample-desc">{sample.description}</span>
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="tc-sample-note">
                  <Info size={14} aria-hidden="true" />
                  <span>
                    示例营业时间为示意数据，不构成真实营业时间承诺
                    （示例是人工写的，不是抓取的真实数据，只用于演示格式与判定逻辑）。
                  </span>
                </p>
              </div>

              <div className="tc-field">
                <div className="tc-label-row">
                  <label className="tc-inline-label" htmlFor="tc-json-input">
                    行程 JSON
                  </label>
                  <span className={`tc-hint${tooLarge ? " tc-hint-warn" : ""}`}>
                    {jsonBytes} / {MAX_BODY_BYTES} 字节
                    {tooLarge ? " · 已超过上限，提交会被 413 拒绝" : ""}
                  </span>
                </div>
                <textarea
                  id="tc-json-input"
                  className="tc-textarea"
                  value={jsonText}
                  onChange={(event) => {
                    setJsonText(event.target.value);
                    setSampleId(null);
                    clearOutcome();
                  }}
                  placeholder={'{\n  "specVersion": "trip-check/0.1",\n  "days": [ ... ]\n}'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  aria-describedby="tc-json-help"
                  disabled={busy}
                />
                <p className="tc-hint" id="tc-json-help">
                  需要 <code className="tc-mono">specVersion: &quot;trip-check/0.1&quot;</code> 与{" "}
                  <code className="tc-mono">days[]</code>；完整机器契约见{" "}
                  <a href="/api/verify/schema" target="_blank" rel="noreferrer">
                    JSON Schema
                  </a>
                  。字段越全判得越多：缺 durationMin / costCny / legs 时，对应判定会如实跳过，不按 0
                  补齐。
                </p>
              </div>
            </>
          ) : (
            <div className="tc-field">
              <label className="tc-inline-label" htmlFor="tc-share-input">
                分享行程 ID
              </label>
              <input
                id="tc-share-input"
                className="tc-input"
                type="text"
                value={shareId}
                onChange={(event) => {
                  setShareId(event.target.value);
                  clearOutcome();
                }}
                placeholder="share_xxxxxxxxxxxx"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="tc-share-help"
                disabled={busy}
              />
              <p className="tc-hint" id="tc-share-help">
                从分享页地址 <code className="tc-mono">/p/share_…</code> 里取这段 ID；
                服务端会先把行程适配成开放文档再跑同一套规则。找不到会返回 404（不会编造结论）。
              </p>
            </div>
          )}

          <div className="tc-actions">
            <button
              type="button"
              className="btn btn-primary tc-run-btn"
              onClick={() =>
                void submit(
                  mode === "document"
                    ? { mode: "document", json: jsonText }
                    : { mode: "share", shareId },
                )
              }
              disabled={busy}
            >
              {loading ? (
                <Loader2 size={16} className="spin" aria-hidden="true" />
              ) : (
                <Play size={16} aria-hidden="true" />
              )}
              {loading ? "体检中…" : "开始体检"}
            </button>
            <label className="tc-pace">
              <span>判定口径</span>
              <select
                id="tc-pace-select"
                name="pace"
                className="tc-select"
                value={pace}
                onChange={(event) => setPace(event.target.value as Pace)}
                disabled={busy}
                aria-describedby="tc-pace-help"
              >
                {PACE_OPTIONS.map((option) => (
                  <option key={option.value || "default"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="btn tc-clear-btn" onClick={clearAll} disabled={busy}>
              <Trash2 size={14} aria-hidden="true" />
              清空
            </button>
          </div>
          <p className="tc-hint" id="tc-pace-help">
            口径会写进凭据输入哈希：同一份文档换口径，结论与凭据 ID 都可能不同。
          </p>

          <p className="tc-status" role="status" aria-live="polite">
            {loading
              ? "正在用确定性规则引擎复算这份文档…"
              : repairing
                ? "正在确定性修复（只顺延时间/删重复）并重新体检…"
                : repairResult
                  ? "确定性修复完成。"
                  : ""}
          </p>

          {error && (
            <div className="tc-alert" role="alert">
              <div className="tc-alert-head">
                <AlertTriangle size={17} aria-hidden="true" />
                <h3>{error.title}</h3>
              </div>
              {error.message && <p className="tc-alert-message">{error.message}</p>}
              {error.items && error.items.length > 0 && (
                <ul className="tc-error-list">
                  {error.items.map((item, index) => (
                    <li key={`${item.path}-${index}`}>
                      <code className="tc-mono">{item.path}</code>
                      <span>{item.message}</span>
                    </li>
                  ))}
                </ul>
              )}
              {error.items && error.items.length === 0 && (
                <p className="tc-hint">服务端没有给出字段级错误。</p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="tc-result" ref={resultRef} tabIndex={-1}>
        {/* shareId 模式：报告背后的行程是持久化的，可以生成可分享的报告页/海报 */}
        {report && mode === "share" && shareId.trim() && (
          <p className="tc-hint">
            <Link
              href={`/p/${encodeURIComponent(shareId.trim())}/check`}
              target="_blank"
              rel="noreferrer"
              className="btn-link"
            >
              查看可分享的体检报告 →
            </Link>
          </p>
        )}
        {report && (
          <TripCheckReport
            report={report}
            repair={repairResult}
            repairing={repairing}
            repairError={repairError}
            onRepair={() => void runRepair()}
          />
        )}
      </div>
    </section>
  );
}
