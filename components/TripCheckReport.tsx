"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Info,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import type {
  FactsVerdict,
  IssueEvidence,
  IssueSeverity,
  OverallStatus,
  TripCheckCredential,
  TripCheckReport as TripCheckReportData,
  VerifyIssue,
  VerifySource,
} from "@/lib/verify/types";

// ============================================================
// Trip Check 报告渲染（客户端展示层，不含任何判定逻辑）
//
// 三条展示纪律（与 lib/verify 的诚实红线同源）：
// 1) 两轴分开：结构自洽性给 A–D + 分数；事实核验只给覆盖率与三态，不折成
//    「可信度分数」——混成一个数字就是用确定性掩盖不确定性。
// 2) 未核验 ≠ 没问题：facts=unverified / inconclusive / partial 各有明确文案，
//    不许把「没查」渲染成「通过」。
// 3) 凭据只声称可复算：同一文档 + 同版本引擎 → 同一 ID；它不是签名，也
//    不构成对真实世界的背书（见 docs/TRIP-CHECK-STANDARD.md §6）。
// ============================================================

const OVERALL_META: Record<
  OverallStatus,
  { label: string; headline: string; tone: "ok" | "warn" | "bad" }
> = {
  ok: { label: "可执行", headline: "按文档数据，这份行程可以照着走", tone: "ok" },
  warnings: {
    label: "可执行 · 有需微调项",
    headline: "按文档数据能走，但有几处需要微调",
    tone: "warn",
  },
  blocking: { label: "走不通", headline: "按文档数据走不通", tone: "bad" },
  unverified: {
    label: "事实未核验",
    headline: "结构上看能走，但事实未核验——这不算通过",
    tone: "warn",
  },
};

const FACTS_META: Record<
  FactsVerdict["state"],
  { label: string; tone: "ok" | "warn" | "neutral" | "bad" }
> = {
  verified: { label: "已核验", tone: "ok" },
  partial: { label: "部分核验", tone: "warn" },
  unverified: { label: "未核验", tone: "warn" },
  inconclusive: { label: "无可核验点位", tone: "neutral" },
};

const GRADE_TONE: Record<TripCheckReportData["verdict"]["consistency"]["grade"], string> = {
  A: "ok",
  B: "ok",
  C: "warn",
  D: "bad",
};

const SOURCE_LABEL: Record<VerifySource, string> = {
  amap: "高德",
  google_places: "Google Places",
  osm: "OSM",
  manual: "人工填写",
  mock: "模拟数据（mock）",
  other: "其他",
};

const SEVERITY_GROUPS: {
  severity: IssueSeverity;
  title: string;
  tone: "bad" | "warn" | "neutral";
}[] = [
  { severity: "blocking", title: "阻断 · 按文档走不通", tone: "bad" },
  { severity: "warning", title: "需微调 · 能走但要改", tone: "warn" },
  { severity: "info", title: "信息不足 · 不是通过，是不知道", tone: "neutral" },
];

/** ISO 时间 → "YYYY-MM-DD HH:MM UTC"；保留 UTC 标识，避免读者误按本地时区理解 */
function formatIssuedAt(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/**
 * 证据摘要：把结构化证据翻成可对账的短语，不使用自然语言重新解释结论。
 * 顺序固定，便于同一规则在不同报告里肉眼比对。
 */
function evidenceLines(e: IssueEvidence): string[] {
  const lines: string[] = [];
  if (e.day !== undefined) lines.push(`第 ${e.day} 天`);
  if (e.date) lines.push(`日期 ${e.date}`);
  if (e.from && e.to) lines.push(`路段 ${e.from} → ${e.to}`);
  else if (e.spot) lines.push(`点位 ${e.spot}`);
  if (e.names && e.names.length > 0) {
    const shown = e.names.slice(0, 4).join("、");
    lines.push(`涉及 ${shown}${e.names.length > 4 ? " 等" : ""}`);
  }
  if (e.gapMinutes !== undefined) lines.push(`时间差 ${e.gapMinutes} 分钟`);
  else if (e.minutes !== undefined) lines.push(`实测 ${e.minutes} 分钟`);
  if (e.needMinutes !== undefined) lines.push(`需要 ${e.needMinutes} 分钟`);
  if (e.limitMinutes !== undefined) lines.push(`阈值 ${e.limitMinutes} 分钟`);
  if (e.count !== undefined && !e.names) lines.push(`数量 ${e.count}`);
  if (e.amountCny !== undefined) lines.push(`金额 ¥${e.amountCny}`);
  if (e.budgetCny !== undefined) lines.push(`预算 ¥${e.budgetCny}`);
  if (e.raw) lines.push(`原文「${e.raw}」`);
  if (e.field) lines.push(`字段 ${e.field}`);
  if (e.source) lines.push(`来源 ${SOURCE_LABEL[e.source] ?? e.source}`);
  return [...new Set(lines)];
}

function IssueRow({ issue }: { issue: VerifyIssue }) {
  const evidence = evidenceLines(issue.evidence);
  return (
    <li className={`tc-issue tc-issue-${issue.severity}`}>
      <div className="tc-issue-head">
        <h5 className="tc-issue-title">{issue.title}</h5>
        <code className="tc-rule-id" title="规则 ID">
          {issue.ruleId}
        </code>
      </div>
      <p className="tc-issue-detail">{issue.detail}</p>
      {evidence.length > 0 && (
        <ul className="tc-evidence" aria-label="可对账证据">
          {evidence.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {issue.fixHint && (
        <p className="tc-fix">
          <b>修复方向</b>（只给提示，不自动修改）：{issue.fixHint}
        </p>
      )}
    </li>
  );
}

function CredentialBlock({
  credential,
  report,
}: {
  credential: TripCheckCredential;
  report: TripCheckReportData;
}) {
  const [copyId, setCopyId] = useState<"idle" | "ok" | "fail">("idle");
  const [copyJson, setCopyJson] = useState<"idle" | "ok" | "fail">("idle");

  async function copy(text: string, target: "id" | "json") {
    const set = target === "id" ? setCopyId : setCopyJson;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(text);
      set("ok");
    } catch {
      set("fail");
    }
  }

  return (
    <section className="tc-credential card" aria-labelledby="tc-credential-title">
      <div className="card-body">
        <div className="tc-credential-head">
          <h3 id="tc-credential-title">体检凭据</h3>
          <span className="tc-axis-note">可复算 · 不是签名</span>
        </div>

        <div className="tc-cred-id-row">
          <code className="tc-cred-id" data-testid="tc-credential-id">
            {credential.id}
          </code>
          <button
            type="button"
            className="btn tc-copy-btn"
            onClick={() => void copy(credential.id, "id")}
          >
            {copyId === "ok" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} />}
            {copyId === "ok" ? "已复制" : "复制 ID"}
          </button>
        </div>
        {copyId === "fail" && (
          <p className="tc-copy-fb" role="status">
            浏览器不允许写入剪贴板：请手动选中上面的凭据 ID 复制（它是可选中文本）。
          </p>
        )}

        <dl className="tc-cred-grid">
          <div>
            <dt>规范版本</dt>
            <dd className="tc-mono">{credential.specVersion}</dd>
          </div>
          <div>
            <dt>引擎 / 规则集</dt>
            <dd className="tc-mono">
              {credential.engineVersion} / {credential.rulesetVersion}
            </dd>
          </div>
          <div>
            <dt>输入哈希（前 16 位）</dt>
            <dd className="tc-mono" title={credential.inputHash}>
              {credential.inputHash.slice(0, 16)}…
            </dd>
          </div>
          <div>
            <dt>签发时间</dt>
            <dd className="tc-mono">{formatIssuedAt(credential.issuedAt)}</dd>
          </div>
        </dl>

        <p className="tc-cred-note">同一文档 + 同版本引擎 → 同一凭据 ID，可独立复算。</p>
        <p className="tc-cred-sub">
          凭据是确定性哈希（{credential.algorithm}
          ），只证明「结论可复现、可对账」，不是数字签名，也不构成 对真实世界的背书。ID 口径：
          <code className="tc-mono">{credential.basis}</code>。
        </p>

        <div className="tc-copy-row">
          <button
            type="button"
            className="btn tc-copy-btn"
            onClick={() => void copy(JSON.stringify(report, null, 2), "json")}
          >
            {copyJson === "ok" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} />}
            {copyJson === "ok" ? "已复制完整报告" : "复制完整报告 JSON"}
          </button>
          {copyJson === "fail" && (
            <p className="tc-copy-fb" role="status">
              浏览器不允许写入剪贴板：展开下方「完整报告 JSON」手动复制。
            </p>
          )}
        </div>

        <details className="tc-json-details">
          <summary>完整报告 JSON（可手动复制）</summary>
          <pre className="tc-json">{JSON.stringify(report, null, 2)}</pre>
        </details>
      </div>
    </section>
  );
}

export function TripCheckReport({ report }: { report: TripCheckReportData }) {
  const { verdict, document: doc, stats, issues } = report;
  const overall = OVERALL_META[verdict.overall];
  const consistency = verdict.consistency;
  const facts = verdict.facts;
  const factsMeta = FACTS_META[facts.state];
  const coverage = facts.coverage;
  const sourceEntries = Object.entries(facts.sources) as [VerifySource, number][];

  const factsNotes: string[] = [];
  if (facts.state === "unverified") {
    factsNotes.push(
      "未核验 ≠ 没问题：文档没有声明可用的来源，这份报告只能判断结构自洽，不能判断地点是否真实存在、当天是否开门。",
    );
  }
  if (facts.state === "inconclusive") {
    factsNotes.push("没有可核验的点位（空天或只有交通描述），事实轴无法给出结论。");
  }
  if (facts.state === "partial") {
    factsNotes.push("只核验了一部分：覆盖不到的地方仍然是「不知道」，不能当成没问题。");
  }
  if (coverage.poiError > 0) {
    factsNotes.push(
      `有 ${coverage.poiError} 个地点的存在性查询失败：这是「不知道」，不是「地点不存在」。`,
    );
  }
  if (sourceEntries.some(([source]) => source === "mock")) {
    factsNotes.push("来源含 mock（模拟数据）：只用于演示格式与判定逻辑，不冒充真实核验。");
  }

  const groups = SEVERITY_GROUPS.map((g) => ({
    ...g,
    items: issues.filter((i) => i.severity === g.severity),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="tc-report">
      <header className="tc-report-head">
        <div>
          <p className="tc-report-eyebrow">Trip Check 体检报告</p>
          <h2 className="tc-report-title" id="tc-result-title">
            {overall.headline}
          </h2>
          <p className="tc-report-doc">
            {doc.city ? `${doc.city} · ` : ""}
            {doc.days} 天 · {doc.spots} 个点位
            {doc.budgetCny !== undefined ? ` · 人均预算 ¥${doc.budgetCny}` : " · 未声明预算"}
          </p>
        </div>
        <p className="tc-report-time">判定 {formatIssuedAt(report.checkedAt)}</p>
      </header>

      {/* 总评：先回答「能不能照着走」，再说问题规模；blocking 用 alert 显著提示 */}
      <div
        className={`tc-verdict tc-verdict-${overall.tone}`}
        role={verdict.overall === "blocking" ? "alert" : "status"}
      >
        <div className="tc-verdict-main">
          {overall.tone === "bad" ? (
            <ShieldAlert size={22} aria-hidden="true" />
          ) : overall.tone === "warn" ? (
            <AlertTriangle size={22} aria-hidden="true" />
          ) : (
            <ShieldCheck size={22} aria-hidden="true" />
          )}
          <div>
            <p className="tc-verdict-label">{overall.label}</p>
            <p className="tc-verdict-summary">{verdict.summary}</p>
          </div>
        </div>
        <ul className="tc-stats" aria-label="问题统计">
          <li className="tc-stat tc-stat-bad">
            阻断 <b>{stats.blocking}</b>
          </li>
          <li className="tc-stat tc-stat-warn">
            需微调 <b>{stats.warnings}</b>
          </li>
          <li className="tc-stat tc-stat-neutral">
            信息不足 <b>{stats.infos}</b>
          </li>
        </ul>
      </div>

      <div className="tc-axes">
        {/* 轴一：结构自洽性（唯一给分数的轴） */}
        <section className="tc-axis card" aria-labelledby="tc-axis-consistency-title">
          <div className="card-body">
            <div className="tc-axis-head">
              <h3 id="tc-axis-consistency-title">结构自洽性</h3>
              <span className="tc-axis-note">只看文档自身 · A–D + 分数</span>
            </div>
            <div className="tc-grade-row">
              <span
                className={`tc-grade-badge tc-grade-${GRADE_TONE[consistency.grade]}`}
                aria-hidden="true"
              >
                {consistency.grade}
              </span>
              <div>
                <p className="tc-grade-label">
                  等级 {consistency.grade} · {consistency.gradeLabel}
                </p>
                <p className="tc-score">
                  评分 <b>{consistency.score}</b> / 100
                </p>
              </div>
            </div>
            <p className="tc-axis-summary">{consistency.summary}</p>
            <p className="tc-axis-foot">
              结构分只由结构问题扣分；「地点没核验」不会扣结构分，也不该扣。
            </p>
          </div>
        </section>

        {/* 轴二：事实核验（覆盖率 + 三态，不折成分数） */}
        <section className="tc-axis card" aria-labelledby="tc-axis-facts-title">
          <div className="card-body">
            <div className="tc-axis-head">
              <h3 id="tc-axis-facts-title">事实核验</h3>
              <span className={`tc-facts-state tc-facts-${factsMeta.tone}`}>{factsMeta.label}</span>
            </div>
            <p className="tc-axis-summary">{facts.summary}</p>
            <dl className="tc-coverage">
              <div className="tc-coverage-row">
                <dt>地点存在性</dt>
                <dd>
                  <b>{coverage.poiChecked}</b> / {coverage.poiTotal} 已核验（命中 {coverage.poiHit}{" "}
                  · 未命中 {coverage.poiMiss} · 查询失败 {coverage.poiError} · 未查{" "}
                  {coverage.poiNotChecked}）
                </dd>
              </div>
              <div className="tc-coverage-row">
                <dt>营业时间</dt>
                <dd>
                  <b>{coverage.hoursChecked}</b> / {coverage.poiTotal} 个点位有可解析数据
                </dd>
              </div>
              <div className="tc-coverage-row">
                <dt>真实路段</dt>
                <dd>
                  {coverage.routesTotal === 0
                    ? "文档未提供相邻路段，无法判断通勤（这不是通过）"
                    : `${coverage.routesChecked} / ${coverage.routesTotal} 段有真实耗时`}
                </dd>
              </div>
            </dl>
            <div className="tc-sources">
              <p className="tc-sources-title">来源（谁的数据）</p>
              {sourceEntries.length > 0 ? (
                <ul className="tc-source-list">
                  {sourceEntries.map(([source, count]) => (
                    <li key={source} className="tc-source-chip">
                      {SOURCE_LABEL[source] ?? source} × {count}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="tc-hint">文档没有声明任何事实来源。</p>
              )}
            </div>
            {factsNotes.length > 0 && (
              <ul className="tc-notes">
                {factsNotes.map((note) => (
                  <li key={note} className="tc-note">
                    <ShieldQuestion size={14} aria-hidden="true" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <section className="tc-issues" aria-labelledby="tc-issues-title">
        <div className="tc-issues-head">
          <h3 id="tc-issues-title">规则级问题</h3>
          <span className="tc-axis-note">每条都有规则 ID 与可对账证据</span>
        </div>
        {groups.length === 0 ? (
          <p className="tc-empty">
            规则引擎没有筛出问题——这只代表「按当前规则 +
            文档数据」没发现问题，不代表真实世界一定可行。
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.severity} className={`tc-issue-group tc-group-${group.tone}`}>
              <h4 className="tc-group-title">
                {group.title}
                <span className="tc-group-count">{group.items.length} 条</span>
              </h4>
              <ul className="tc-issue-list">
                {group.items.map((issue, index) => (
                  <IssueRow key={`${issue.ruleId}-${index}`} issue={issue} />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {report.credential ? (
        <CredentialBlock credential={report.credential} report={report} />
      ) : (
        <p className="tc-credential-missing">
          <Info size={14} aria-hidden="true" /> 这份报告没有携带凭据（可能来自未签发的直连调用）。
        </p>
      )}

      <section className="tc-honesty" aria-labelledby="tc-honesty-title">
        <h3 id="tc-honesty-title">这份报告的边界</h3>
        <ul>
          <li>
            <b>只判定、不修改：</b>修复方向只是提示，引擎不会替你改行程。
          </li>
          <li>
            <b>未核验 ≠ 没问题：</b>
            没有声明事实来源时，报告只能判断结构自洽，不能判断地点是否真实、当天是否开门。
          </li>
          <li>
            <b>MOCK 不冒充真实核验：</b>来源标注为 mock 的数据只用于演示格式与判定逻辑。
          </li>
          <li>
            <b>示例营业时间为示意数据，不构成真实营业时间承诺：</b>
            真实营业时间以出发前官方信息为准；凭据签发之后的变化无法覆盖。
          </li>
          <li>
            <b>无状态判定：</b>按 Trip Check
            v0.1，输入文档只用于本次判定，不落库；凭据只对「这份输入 + 这版引擎/规则」负责。
          </li>
        </ul>
      </section>
    </div>
  );
}
