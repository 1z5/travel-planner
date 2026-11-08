"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, RotateCcw } from "lucide-react";
import { parseTimeRange } from "@/lib/plan/schedule";
import { PENDING_CHECK_TEXT_KEY } from "@/lib/jobs/pending-check";
import type { TripCheckDocument, TripCheckReport as TripCheckReportData } from "@/lib/verify/types";
import {
  TripCheckReport,
  type RepairViewError,
  type TripCheckRepairResponse,
} from "@/components/TripCheckReport";

// ============================================================
// 行程验真台（产品主链路，不是开发者体验台）
//
// 与 components/TripCheckPlayground.tsx 的分工：那个是给开发者/agent 贴
// 标准 JSON 的开放体验台，留在营销页；这个是给普通人的——第一动作是「把
// 手上那份行程贴进来」，不要求懂 JSON、不要求懂 Trip Check。
//
// 三段式是刻意的，不能合并成「贴完直接出报告」：
//   input → confirm → report
// 中间那一步把 AI 读出来的每一个点位、每一个时刻摊开让人核对。任意来源的
// 文本里「上午」「逛一会」极多，模型一旦自作主张换算成 09:00-11:00，
// 下游确定性引擎会为一份虚构的文档签出可复算凭据——那比报错危害大得多。
// 所以「不确定」必须可见、可改，且用户不改也只会被如实判为信息不足。
// ============================================================

type Stage = "input" | "confirm" | "report";

/** 演示样本故意留了时间重叠、重复点位和「上午」这类模糊表述，用来展示体检与一键理顺。 */
const SAMPLE_TEXT = `苏州 3 天，人均预算 2000 元
第 1 天：
09:00-11:00 拙政园，门票 80
10:30-12:00 苏州博物馆，免费
14:00-16:00 平江路 Citywalk
第 2 天：
上午 虎丘
下午 留园
晚上 山塘街
第 3 天：
09:00-11:00 狮子林
09:00-11:00 狮子林
14:00-16:00 耦园`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReport(value: unknown): value is TripCheckReportData {
  if (!isRecord(value) || !isRecord(value.verdict)) return false;
  return isRecord(value.verdict.consistency) && isRecord(value.verdict.facts);
}

function isRepairResponse(value: unknown): value is TripCheckRepairResponse {
  if (!isRecord(value) || !isRecord(value.document) || !isRecord(value.delta)) return false;
  if (!isReport(value.before) || !isReport(value.after)) return false;
  return (
    Array.isArray(value.applied) &&
    Array.isArray(value.unrepairable) &&
    Array.isArray(value.remainingRuleIds) &&
    typeof value.changed === "boolean" &&
    isRecord(value.parentCredential) &&
    isRecord(value.credential)
  );
}

async function errorOf(res: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const data = isRecord(payload) ? payload : {};
  if (typeof data.error === "string" && data.error) return data.error;
  return `服务返回 HTTP ${res.status}，请稍后重试。`;
}

export function TripCheckDesk() {
  const [stage, setStage] = useState<Stage>("input");
  const [text, setText] = useState("");
  const [reading, setReading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [document, setDocument] = useState<TripCheckDocument | null>(null);
  const [uncertain, setUncertain] = useState<string[]>([]);
  const [report, setReport] = useState<TripCheckReportData | null>(null);
  const [repair, setRepair] = useState<TripCheckRepairResponse | null>(null);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState<RepairViewError | null>(null);
  const busyRef = useRef(false);
  const autoRanRef = useRef(false);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const pendingTextRef = useRef("");
  // 修复必须复用「产出当前报告的那份输入」；重新解析 textarea 会与报告口径不一致
  const lastBodyRef = useRef<Record<string, unknown> | null>(null);

  const clearOutcome = useCallback(() => {
    setReport(null);
    setRepair(null);
    setRepairError(null);
    lastBodyRef.current = null;
  }, []);

  /** 贴文本 → 开放文档：这一步调模型，结果只作草稿，必须经人确认。 */
  const runExtract = useCallback(
    async (raw: string) => {
      if (busyRef.current) return;
      const trimmed = raw.trim();
      if (trimmed.length < 20) {
        setError("再多贴一点吧，至少 20 个字才读得出行程。");
        return;
      }
      busyRef.current = true;
      setReading(true);
      setError("");
      clearOutcome();
      try {
        const res = await fetch("/api/verify/extract", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
        if (!res.ok) {
          setError(await errorOf(res));
          return;
        }
        const data = (await res.json()) as unknown;
        if (!isRecord(data) || !Array.isArray(data.uncertain)) {
          setError("服务返回的内容不符合约定，请重试。");
          return;
        }
        const notes = data.uncertain.filter((n): n is string => typeof n === "string");
        if (!isRecord(data.document) || !Array.isArray(data.document.days)) {
          setDocument(null);
          setUncertain(notes);
          setError(
            "这段文字里没读到行程点位。可以换成「第 1 天 / 景点 + 时间」这样的写法，或点上面的示例看看。",
          );
          return;
        }
        setDocument(data.document as unknown as TripCheckDocument);
        setUncertain(notes);
        setStage("confirm");
      } catch {
        setError("没收到响应，请检查网络后重试。");
      } finally {
        busyRef.current = false;
        setReading(false);
      }
    },
    [clearOutcome],
  );

  // 首页粘贴框跳转过来时自动开始，用户不必再点一次「读一遍」。
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    let pending = "";
    try {
      pending = window.sessionStorage.getItem(PENDING_CHECK_TEXT_KEY) ?? "";
      if (pending) window.sessionStorage.removeItem(PENDING_CHECK_TEXT_KEY);
    } catch {
      pending = "";
    }
    if (pending) {
      // 不在 effect 里 setState（React 19 反模式，oxlint set-state-in-effect）：
      // 原文只存进 ref，等用户点「重新贴一段」时再放回输入框，顺手省掉 SSR
      // hydration 不一致的风险。
      pendingTextRef.current = pending;
      // 与 sessionStorage 同步后启动一次异步抽取；runExtract 里的 setState
      // 全在 await 之后，不是同步级联渲染。
      // eslint-disable-next-line react/set-state-in-effect -- 异步任务，非同步 setState
      void runExtract(pending);
    }
  }, [runExtract]);

  /** 确认页改时刻：只改时间字符串，其余字段一律不动（不替用户做取舍）。 */
  function editTime(dayIndex: number, spotIndex: number, value: string) {
    setDocument((prev) => {
      if (!prev) return prev;
      const days = prev.days.map((day, di) =>
        di !== dayIndex
          ? day
          : {
              ...day,
              spots: day.spots.map((spot, si) =>
                si !== spotIndex ? spot : { ...spot, time: value },
              ),
            },
      );
      return { ...prev, days };
    });
    clearOutcome();
  }

  /** 提交体检：空时刻回填「未标注」，让引擎判「信息不足」而不是吃 400。 */
  const runVerify = useCallback(async () => {
    if (busyRef.current || !document) return;
    const days = document.days.map((day) => ({
      ...day,
      spots: day.spots.map((spot) => ({
        ...spot,
        time: spot.time.trim() === "" ? "未标注" : spot.time,
      })),
    }));
    const body: Record<string, unknown> = { document: { ...document, days } };
    busyRef.current = true;
    setChecking(true);
    setError("");
    clearOutcome();
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await errorOf(res));
        return;
      }
      const data = (await res.json()) as unknown;
      if (!isReport(data)) {
        setError("体检结果格式不符合约定，请重试。");
        return;
      }
      lastBodyRef.current = body;
      setReport(data);
      setStage("report");
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resultRef.current?.focus());
      }
    } catch {
      setError("体检请求没收到响应，请检查网络后重试。");
    } finally {
      busyRef.current = false;
      setChecking(false);
    }
  }, [document, clearOutcome]);

  const runRepair = useCallback(async () => {
    if (busyRef.current || !lastBodyRef.current) return;
    busyRef.current = true;
    setRepairing(true);
    setRepairError(null);
    setRepair(null);
    try {
      const res = await fetch("/api/verify/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(lastBodyRef.current),
      });
      if (!res.ok) {
        setRepairError({ title: "一键理顺没完成", message: await errorOf(res) });
        return;
      }
      const data = (await res.json()) as unknown;
      if (!isRepairResponse(data)) {
        setRepairError({ title: "修复结果不符合约定", message: "请重试，当前体检报告不受影响。" });
        return;
      }
      setRepair(data);
    } catch {
      setRepairError({ title: "网络错误", message: "修复请求没收到响应，当前体检报告不受影响。" });
    } finally {
      busyRef.current = false;
      setRepairing(false);
    }
  }, []);

  function reset() {
    setStage("input");
    setText(pendingTextRef.current);
    setDocument(null);
    setUncertain([]);
    setError("");
    clearOutcome();
  }

  return (
    <div className="check-desk">
      <header className="desk-head">
        <p className="desk-kicker">把行程交给我</p>
        <h1 className="desk-title">先看看，这份行程能不能照着走</h1>
        <p className="desk-lede">
          ChatGPT 写的、小红书抄的、朋友发来的，直接贴进来就行——不用重新填表，也不用等几分钟生成。
          我会把接不上的时间、重复的点位、超出预算的地方一条条摊开给你看。
        </p>
      </header>

      {error && (
        <p className="desk-error" role="alert">
          {error}
        </p>
      )}

      {stage === "input" && (
        <section className="card desk-card" aria-label="粘贴行程">
          <div className="card-body">
            <label className="desk-label" htmlFor="desk-text">
              你的行程原文
            </label>
            <textarea
              id="desk-text"
              className="desk-textarea"
              value={text}
              maxLength={8000}
              placeholder={
                "例：\n苏州 3 天，人均 2000\n第 1 天：09:00-11:00 拙政园，14:00-16:00 平江路…"
              }
              onChange={(e) => setText(e.target.value)}
              disabled={reading}
            />
            <div className="desk-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runExtract(text)}
                disabled={reading || text.trim().length < 20}
              >
                {reading ? (
                  <>
                    <Loader2 size={15} className="spin" aria-hidden="true" /> 正在读…
                  </>
                ) : (
                  <>
                    读一遍并体检 <ArrowRight size={15} aria-hidden="true" />
                  </>
                )}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setText(SAMPLE_TEXT);
                  setError("");
                }}
                disabled={reading}
              >
                贴一段示例试试
              </button>
            </div>
            <p className="helper desk-honest">
              这一步只核对时间安排、节奏和预算，
              <strong>不会查地点是否真实存在、当天是否开门</strong>
              ；没查过的会明确写成「未核验」，不拿「没报错」冒充「没问题」。
            </p>
            <p className="helper">
              想从零排一份，或想连地点一起核验？
              <Link href="/new" className="btn-link">
                去新建一份行程 →
              </Link>
            </p>
          </div>
        </section>
      )}

      {stage === "confirm" && document && (
        <section className="card desk-card" aria-label="核对读到的内容">
          <div className="card-body">
            <h2 className="desk-subtitle">先核对一下，我读到了这些</h2>
            <p className="muted">
              下面每条都是从你贴的原文里读出来的，我没有补任何东西。原文没写明确时间的标成「未标注」，
              你可以直接改；不改的话，体检会如实算作「信息不足」，不会替你编一个 09:00。
            </p>

            {uncertain.length > 0 && (
              <details className="desk-uncertain" open>
                <summary>{uncertain.length} 项需要你留意</summary>
                <ul>
                  {uncertain.map((note, i) => (
                    <li key={`${i}-${note.slice(0, 12)}`}>{note}</li>
                  ))}
                </ul>
              </details>
            )}

            <div className="desk-days">
              {document.days.map((day, di) => (
                <div className="desk-day" key={day.day}>
                  <p className="desk-day-head">
                    第 {day.day} 天{day.date ? ` · ${day.date}` : ""}
                    <span className="muted"> · {day.spots.length} 站</span>
                  </p>
                  <ul className="desk-spots">
                    {day.spots.map((spot, si) => (
                      <li key={`${day.day}-${si}`} className="desk-spot">
                        <span className="desk-spot-name">{spot.name}</span>
                        <input
                          type="text"
                          aria-label={`第 ${day.day} 天 ${spot.name} 的时间`}
                          value={spot.time}
                          onChange={(e) => editTime(di, si, e.target.value)}
                          className={parseTimeRange(spot.time) === null ? "is-unspecified" : ""}
                          maxLength={40}
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <div className="desk-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void runVerify()}
                disabled={checking}
              >
                {checking ? (
                  <>
                    <Loader2 size={15} className="spin" aria-hidden="true" /> 正在体检…
                  </>
                ) : (
                  <>
                    确认，开始体检 <ArrowRight size={15} aria-hidden="true" />
                  </>
                )}
              </button>
              <button type="button" className="btn" onClick={reset} disabled={checking}>
                <RotateCcw size={14} aria-hidden="true" /> 重新贴一段
              </button>
            </div>
          </div>
        </section>
      )}

      {stage === "report" && report && (
        <div ref={resultRef} tabIndex={-1}>
          <section className="card desk-card desk-summary">
            <div className="card-body">
              <h2 className="desk-subtitle">
                {report.stats.blocking > 0
                  ? `发现 ${report.stats.blocking} 处会卡住行程，${report.stats.warnings} 处建议调整`
                  : report.stats.warnings > 0
                    ? `没有会卡住的问题，有 ${report.stats.warnings} 处建议调整`
                    : "没发现会卡住的问题"}
              </h2>
              <p className="muted">{report.verdict.summary}</p>
              <p className="helper">
                事实核验这一栏是「未核验」是对的：本页只读了你贴的文本，没有查高德。
                要连地点真实存在、当天是否开门一起验，可以
                <Link href="/new" className="btn-link">
                  按你的日期生成一份经核验的行程 →
                </Link>
              </p>
            </div>
          </section>

          <TripCheckReport
            report={report}
            repair={repair}
            repairing={repairing}
            repairError={repairError}
            onRepair={() => void runRepair()}
          />

          <div className="desk-actions desk-after">
            <button type="button" className="btn" onClick={reset}>
              <RotateCcw size={14} aria-hidden="true" /> 再验一份
            </button>
            <Link href="/p/share_Z5oYam8ahjqb" className="btn">
              看一份接了高德数据的成品 →
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
