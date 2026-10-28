"use client";

import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { reportPlainText } from "@/lib/trip-check-report";
import type { TripCheckReport as TripCheckReportData } from "@/lib/verify/types";

// ============================================================
// 体检报告的「传播动作」（client）：复制纯文本、复制 JSON、下载 JSON、保存海报。
//
// 为什么纯文本也要能复制：微信/邮件/工单里没人读 JSON，但一段带规则 ID 与凭据
// ID 的纯文本既方便转发、又能让对方按 ID 复算。文本由 lib/trip-check-report.ts
// 的 reportPlainText 统一生成（页面/海报/文本同源，不各说一套）。
//
// 降级原则：剪贴板/Blob 下载都可能在浏览器里失败（权限、老浏览器、内嵌 webview）。
// 失败时不假装成功——给出原因，并展开可手动复制的 <details>（内容永远可读）。
// ============================================================

type ActionState = "idle" | "ok" | "fail";

export function TripCheckShareActions({
  report,
  credentialId,
  shareId,
  reportUrl,
}: {
  /** 页面应传入已附加 credential 的报告（分享页/报告页由 stampPlan 签发） */
  report: TripCheckReportData;
  credentialId: string;
  shareId: string;
  /** 报告页绝对地址（用于纯文本里的「在线报告」；缺省时用当前 URL） */
  reportUrl?: string;
}) {
  const [textState, setTextState] = useState<ActionState>("idle");
  const [jsonState, setJsonState] = useState<ActionState>("idle");
  const [downloadState, setDownloadState] = useState<ActionState>("idle");

  // 渲染期可确定的内容（服务端/客户端一致，避免 hydration 不一致）：
  // 纯文本展示版不带 URL（URL 只在复制时按当前页面补上）。
  const plainTextDisplay = reportPlainText(report, { credentialId });
  const reportJson = JSON.stringify(report, null, 2);

  function plainTextForCopy(): string {
    const url = reportUrl || (typeof window !== "undefined" ? window.location.href : "");
    return reportPlainText(report, { credentialId, ...(url ? { url } : {}) });
  }

  async function copyText(text: string, setState: (state: ActionState) => void) {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("fail");
    }
  }

  function downloadJson() {
    try {
      if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        setDownloadState("fail");
        return;
      }
      const blob = new Blob([reportJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `trip-check-${shareId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDownloadState("ok");
    } catch {
      setDownloadState("fail");
    }
  }

  return (
    <section className="tc-report-page-actions" aria-label="分享与导出体检报告">
      <div className="tc-report-page-action-row">
        {/* 海报是传播物料：放在第一个，链到 /p/<id>/check/poster（1080×1920 PNG） */}
        <a
          className="btn btn-primary tc-report-page-poster"
          href={`/p/${encodeURIComponent(shareId)}/check/poster`}
          target="_blank"
          rel="noopener noreferrer"
        >
          保存体检海报
        </a>
        <button
          type="button"
          className="btn"
          onClick={() => void copyText(plainTextForCopy(), setTextState)}
        >
          {textState === "ok" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} />}
          {textState === "ok" ? "已复制纯文本" : "复制纯文本报告"}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => void copyText(reportJson, setJsonState)}
        >
          {jsonState === "ok" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} />}
          {jsonState === "ok" ? "已复制 JSON" : "复制报告 JSON"}
        </button>
        <button type="button" className="btn" onClick={downloadJson}>
          <Download size={14} aria-hidden="true" />
          下载 .json
        </button>
      </div>

      {textState === "fail" && (
        <p className="tc-copy-fb" role="status">
          浏览器不允许写剪贴板：展开下方「纯文本报告」手动复制。
        </p>
      )}
      {jsonState === "fail" && (
        <p className="tc-copy-fb" role="status">
          浏览器不允许写剪贴板：展开下方「报告 JSON」手动复制。
        </p>
      )}
      {downloadState === "ok" && (
        <p className="tc-copy-ok" role="status">
          已开始下载 trip-check-{shareId}.json。
        </p>
      )}
      {downloadState === "fail" && (
        <p className="tc-copy-fb" role="status">
          当前浏览器不支持直接下载：展开下方「报告 JSON」手动保存。
        </p>
      )}

      {/* 手动兜底永远存在：剪贴板/下载都可能被环境禁用 */}
      <details className="tc-report-page-manual">
        <summary>纯文本报告（可手动复制）</summary>
        <pre className="tc-json">{plainTextDisplay}</pre>
      </details>
      <details className="tc-report-page-manual">
        <summary>报告 JSON（可手动复制）</summary>
        <pre className="tc-json">{reportJson}</pre>
      </details>
    </section>
  );
}
