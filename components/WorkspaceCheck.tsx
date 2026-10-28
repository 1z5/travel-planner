"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Wand2,
} from "lucide-react";
import type { Plan } from "@/lib/types";
import { RULES } from "@/lib/verify/rules";
import type {
  FactsVerdict,
  IssueEvidence,
  IssueSeverity,
  OverallStatus,
  RepairApplied,
  RepairUnrepairable,
  TripCheckCredential,
  TripCheckReport as TripCheckReportData,
  VerifyIssue,
  VerifySource,
} from "@/lib/verify/types";

// ============================================================
// 工作台「体检」镜头（第五镜头，?view=check）
//
// 为什么是独立镜头而不是弹窗/徽章：体检是产品内的「证据入口」——两轴结论、
// 规则级证据（ruleId + 可对账证据 + 修复方向）、可复算凭据与修复历史都该是
// 一等公民。这里与 /verify 体验台共享同一套 tc-* 设计语言，但数据入口不同：
//   - POST /api/plan/check  { shareId } → 针对一份已持久化行程的实时体检；
//   - POST /api/plan/repair { shareId, confirm, expectedRevision } → 两段式修复：
//       先 confirm:false 预览（persisted=false，不写库）；
//       再 confirm:true + expectedRevision 写入新 revision（persisted=true）。
// 与 /verify 的核心差异是「写入」：所以这里必须先把改动与修不了的问题摊开，
// 用户点确认后才改行程——不确认绝不写入，也不替用户做取舍。
//
// 展示层不复用 TripCheckReport 组件本身（它的修复区块是 /verify 的一次性
// stateless 语义：直接返回修复文档 + 下载）；但复用其 .tc-* 类名与结构，
// 避免出现两套视觉语言。修复预览区复用 /verify 的 .tc-repair-* 类名。
// ============================================================

/** 行程上已持久化的 Trip Check 元数据（见 lib/types.ts 的 Plan.tripCheck） */
export interface PlanTripCheckMeta {
  credentialId: string;
  parentCredentialId?: string;
  checkedAt?: number;
  repairedAt?: number;
  repairCount?: number;
  applied?: number;
}

/** POST /api/plan/check 的 200 响应 */
export interface PlanCheckResponse {
  shareId: string;
  planRevision: number | null;
  report: TripCheckReportData;
  credential: TripCheckCredential;
  tripCheck: PlanTripCheckMeta | null;
}

/** POST /api/plan/repair confirm:false 的 200 响应（预览，不写库） */
export interface PlanRepairPreview {
  changed: boolean;
  persisted: false;
  planRevision: number | null;
  before: TripCheckReportData;
  after: TripCheckReportData;
  applied: RepairApplied[];
  unrepairable: RepairUnrepairable[];
  parentCredential: TripCheckCredential;
  credential: TripCheckCredential;
}

/** POST /api/plan/repair confirm:true 的 200 响应（写入成功或无事可做） */
export interface PlanRepairConfirm {
  changed: boolean;
  persisted: boolean;
  revision?: number;
  plan?: Plan;
  before?: TripCheckReportData;
  after?: TripCheckReportData;
  applied?: RepairApplied[];
  unrepairable?: RepairUnrepairable[];
  parentCredential?: TripCheckCredential;
  credential?: TripCheckCredential;
}

interface WorkspaceCheckError {
  scope: "check" | "repair" | "confirm";
  title: string;
  message?: string;
  /** 409 时服务端给出的最新 revision（用于提示刷新到哪一版） */
  conflictRevision?: number;
}

type CopyState = "idle" | "ok" | "fail";

const OVERALL_META: Record<OverallStatus, { label: string; tone: "ok" | "warn" | "bad" }> = {
  ok: { label: "可执行", tone: "ok" },
  warnings: { label: "可执行 · 有需微调项", tone: "warn" },
  blocking: { label: "走不通", tone: "bad" },
  unverified: { label: "事实未核验", tone: "warn" },
};

const FACTS_META: Record<
  FactsVerdict["state"],
  { label: string; tone: "ok" | "warn" | "neutral" }
> = {
  verified: { label: "已核验", tone: "ok" },
  partial: { label: "部分核验", tone: "warn" },
  unverified: { label: "未核验", tone: "warn" },
  inconclusive: { label: "无可核验点位", tone: "neutral" },
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

const GRADE_TONE: Record<TripCheckReportData["verdict"]["consistency"]["grade"], string> = {
  A: "ok",
  B: "ok",
  C: "warn",
  D: "bad",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReport(value: unknown): value is TripCheckReportData {
  if (!isRecord(value) || !isRecord(value.verdict)) return false;
  return isRecord(value.verdict.consistency) && isRecord(value.verdict.facts);
}

function isCredential(value: unknown): value is TripCheckCredential {
  return isRecord(value) && typeof value.id === "string";
}

function isCheckResponse(value: unknown): value is PlanCheckResponse {
  if (!isRecord(value) || !isReport(value.report) || !isCredential(value.credential)) return false;
  if (value.planRevision !== null && typeof value.planRevision !== "number") return false;
  return value.tripCheck === null || isRecord(value.tripCheck);
}

function isRepairPreview(value: unknown): value is PlanRepairPreview {
  if (!isRecord(value)) return false;
  if (typeof value.changed !== "boolean") return false;
  if (!isReport(value.before) || !isReport(value.after)) return false;
  if (!Array.isArray(value.applied) || !Array.isArray(value.unrepairable)) return false;
  return isCredential(value.parentCredential) && isCredential(value.credential);
}

function isConfirmResponse(value: unknown): value is PlanRepairConfirm {
  if (!isRecord(value)) return false;
  if (typeof value.changed !== "boolean" || typeof value.persisted !== "boolean") return false;
  if (value.plan !== undefined && !isRecord(value.plan)) return false;
  return true;
}

function isPlan(value: unknown): value is Plan {
  return isRecord(value) && typeof value.city === "string" && Array.isArray(value.days);
}

/** ISO 时间 → "YYYY-MM-DD HH:MM UTC"；保留 UTC 标识，避免读者误按本地时区理解 */
function formatIso(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/** 毫秒时间戳（Plan.tripCheck 里的字段）→ 同样口径 */
function formatMillis(ms: number): string {
  if (!Number.isFinite(ms)) return "未知时间";
  return formatIso(new Date(ms).toISOString());
}

function ruleTitle(ruleId: string): string {
  return RULES[ruleId]?.title ?? ruleId;
}

/** 结构化证据 → 可对账的短语（与 /verify 同口径；UI 不重新解释结论） */
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

async function readErrorBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return isRecord(body) ? body : {};
  } catch {
    return {};
  }
}

async function errorOf(
  res: Response,
  scope: WorkspaceCheckError["scope"],
): Promise<WorkspaceCheckError> {
  const data = await readErrorBody(res);
  // 服务端的 error 文案更具体（例如「旧版分享链接只读、不支持修复」），优先展示；
  // 但仍用本地标题/兜底句保证网络异常、非 JSON 错误也有可读信息。
  const serverMessage = typeof data.error === "string" && data.error ? data.error : "";
  const limit = typeof data.limit === "number" ? `（每小时 ${data.limit} 次）` : "";
  if (res.status === 404) {
    return {
      scope,
      title: "没找到这份行程（404）",
      message:
        serverMessage ||
        "分享链接可能已失效，或行程已被删除；刷新重试不能解决时请回到「我的行程」。",
    };
  }
  if (res.status === 409) {
    const revision = typeof data.revision === "number" ? data.revision : undefined;
    return {
      scope,
      title: "版本冲突（409）",
      message: `行程在你预览之后被更新${
        revision !== undefined ? `到第 ${revision} 版` : ""
      }。请刷新体检后重新预览——确认要改的必须是最新版本。`,
      conflictRevision: revision,
    };
  }
  if (res.status === 429) {
    return {
      scope,
      title: "请求太频繁（429）",
      message: serverMessage || `体检/修复有每小时限流${limit}，等一会儿再试；这不会改动行程。`,
    };
  }
  if (res.status === 400) {
    return {
      scope,
      title: "请求不合法（400）",
      message: serverMessage || "请求参数没有通过服务端校验；请刷新体检后重试。",
    };
  }
  return {
    scope,
    title: `服务端返回 HTTP ${res.status}`,
    message: serverMessage || "这次操作没有完成，请稍后重试；行程内容未被修改。",
  };
}

function ErrorBox({
  error,
  onRetry,
  retryLabel = "重试",
}: {
  error: WorkspaceCheckError;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="tc-alert tc-ws-check-alert" role="alert">
      <div className="tc-alert-head">
        <AlertTriangle size={17} aria-hidden="true" />
        <h3>{error.title}</h3>
      </div>
      {error.message && <p className="tc-alert-message">{error.message}</p>}
      {onRetry && (
        <div className="tc-ws-check-alert-actions">
          <button type="button" className="btn" onClick={onRetry}>
            <RefreshCw size={14} aria-hidden="true" />
            {retryLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** 两轴 + 问题分组 + 凭据：与 /verify 同一套 tc-* 结构，但数据来自 /api/plan/check */
function CheckEvidence({
  report,
  credential,
  shareId,
}: {
  report: TripCheckReportData;
  credential: TripCheckCredential;
  shareId: string;
}) {
  const { verdict, document: doc, stats, issues } = report;
  const overall = OVERALL_META[verdict.overall];
  const consistency = verdict.consistency;
  const facts = verdict.facts;
  const factsMeta = FACTS_META[facts.state];
  const coverage = facts.coverage;
  const sourceEntries = Object.entries(facts.sources) as [VerifySource, number][];
  const [copy, setCopy] = useState<CopyState>("idle");

  async function copyCredentialId() {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(credential.id);
      setCopy("ok");
    } catch {
      setCopy("fail");
    }
  }

  const groups = SEVERITY_GROUPS.map((group) => ({
    ...group,
    items: issues.filter((issue) => issue.severity === group.severity),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="tc-report tc-ws-check-report">
      <header className="tc-report-head">
        <div>
          <p className="tc-report-eyebrow">Trip Check 体检报告</p>
          <h2 className="tc-ws-check-report-title">
            {verdict.overall === "blocking"
              ? "按文档数据走不通"
              : verdict.overall === "unverified"
                ? "结构可执行，但事实未核验"
                : verdict.overall === "warnings"
                  ? "能照着走，但需要微调"
                  : "按文档数据，可以照着走"}
          </h2>
          <p className="tc-report-doc">
            {doc.city ? `${doc.city} · ` : ""}
            {doc.days} 天 · {doc.spots} 个点位
            {doc.budgetCny !== undefined ? ` · 人均预算 ¥${doc.budgetCny}` : " · 未声明预算"}
          </p>
        </div>
        <p className="tc-report-time">判定 {formatIso(report.checkedAt)}</p>
      </header>

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
        <section className="tc-axis card" aria-labelledby="tc-ws-check-consistency-title">
          <div className="card-body">
            <div className="tc-axis-head">
              <h3 id="tc-ws-check-consistency-title">结构自洽性</h3>
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
          </div>
        </section>

        <section className="tc-axis card" aria-labelledby="tc-ws-check-facts-title">
          <div className="card-body">
            <div className="tc-axis-head">
              <h3 id="tc-ws-check-facts-title">事实核验</h3>
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
            {facts.state === "unverified" && (
              <p className="tc-note tc-ws-check-note">
                <ShieldQuestion size={14} aria-hidden="true" />
                <span>
                  未核验 ≠ 没问题：没有来源时只能判断结构自洽，不能判断地点是否真实、当天是否开门。
                </span>
              </p>
            )}
          </div>
        </section>
      </div>

      <section className="tc-issues" aria-labelledby="tc-ws-check-issues-title">
        <div className="tc-issues-head">
          <h3 id="tc-ws-check-issues-title">规则级问题</h3>
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

      <section className="tc-credential card" aria-labelledby="tc-ws-check-credential-title">
        <div className="card-body">
          <div className="tc-credential-head">
            <h3 id="tc-ws-check-credential-title">体检凭据</h3>
            <span className="tc-axis-note">可复算 · 不是签名</span>
          </div>
          <div className="tc-cred-id-row">
            <code className="tc-cred-id" data-testid="tc-ws-check-credential-id">
              {credential.id}
            </code>
            <button
              type="button"
              className="btn tc-copy-btn"
              onClick={() => void copyCredentialId()}
            >
              {copy === "ok" ? <Check size={14} aria-hidden="true" /> : <Copy size={14} />}
              {copy === "ok" ? "已复制" : "复制 ID"}
            </button>
          </div>
          {copy === "fail" && (
            <p className="tc-copy-fb" role="status">
              浏览器不允许写入剪贴板：请手动选中上面的凭据 ID 复制。
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
              <dd className="tc-mono">{formatIso(credential.issuedAt)}</dd>
            </div>
          </dl>
          <p className="tc-cred-note">
            同一份行程 + 同一口径 + 同版本引擎 → 同一凭据 ID，可独立复算。
          </p>
          <p className="tc-cred-sub">
            在开放体检台可以看完整的两轴报告与凭据链：
            <Link
              href={`/verify?share=${encodeURIComponent(shareId)}`}
              target="_blank"
              rel="noreferrer"
            >
              /verify?share={shareId}
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
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
          <b>修复方向</b>（只是提示，不会自动修改）：{issue.fixHint}
        </p>
      )}
    </li>
  );
}

/** 修复预览：before→after、已修/修不了、凭据链、确认/放弃。所有数字来自服务端两次判定。 */
function RepairPreviewBlock({
  preview,
  planRevision,
  confirming,
  onConfirm,
  onCancel,
}: {
  preview: PlanRepairPreview;
  planRevision: number | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { before, after, applied, unrepairable, changed } = preview;
  const beforeGrade = before.verdict.consistency;
  const afterGrade = after.verdict.consistency;
  const nextVersion = planRevision !== null ? `第 ${planRevision + 1} 版` : "新版本";

  return (
    <div className="tc-repair-result">
      <div className={`tc-repair-verdict ${changed ? "tc-repair-improved" : "tc-repair-noop"}`}>
        <p className="tc-repair-verdict-label">
          {changed ? "预览：确认后才写入" : "没有可机械修复的问题"}
        </p>
        <p className="tc-repair-verdict-text">
          {changed
            ? `下面是确定性修复的预览（还没写入）。检查改动与修不了的问题后，点「确认写入${nextVersion}」才会把改动保存到这份行程。`
            : "这份行程当前没有「顺延时间 / 删同日重复」能处理的项；其余问题需要人工判断，逐条列在下面。预览不会改动行程。"}
        </p>
      </div>

      <div className="tc-repair-compare" role="group" aria-label="修复前后对比">
        <div className="tc-repair-side">
          <p className="tc-repair-side-label">修复前</p>
          <p className="tc-repair-side-grade">
            等级 {beforeGrade.grade} · {beforeGrade.gradeLabel}
          </p>
          <p className="tc-repair-side-score">评分 {beforeGrade.score} / 100</p>
          <p className="tc-repair-side-blocking">阻断 {before.stats.blocking}</p>
        </div>
        <span className="tc-repair-arrow" aria-hidden="true">
          →
        </span>
        <div className="tc-repair-side tc-repair-side-after">
          <p className="tc-repair-side-label">修复后</p>
          <p className="tc-repair-side-grade">
            等级 {afterGrade.grade} · {afterGrade.gradeLabel}
          </p>
          <p className="tc-repair-side-score">评分 {afterGrade.score} / 100</p>
          <p className="tc-repair-side-blocking">阻断 {after.stats.blocking}</p>
        </div>
      </div>
      <p className="tc-repair-delta">
        {beforeGrade.grade === afterGrade.grade
          ? `等级保持 ${afterGrade.grade}`
          : `等级 ${beforeGrade.grade} → ${afterGrade.grade}`}{" "}
        · 分数 {beforeGrade.score} → {afterGrade.score} · 阻断 {before.stats.blocking} →{" "}
        {after.stats.blocking}
      </p>

      <div className="tc-repair-block">
        <h4 className="tc-repair-block-title">
          将确定性修复 <span className="tc-repair-count">{applied.length} 处</span>
        </h4>
        {applied.length > 0 ? (
          <ul className="tc-repair-applied">
            {applied.map((item, index) => (
              <li key={`${item.ruleId}-${item.day}-${index}`}>
                <span className="tc-repair-rule">{ruleTitle(item.ruleId)}</span>
                <p className="tc-repair-detail">{item.detail}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tc-hint">没有可应用的修复（文档没有变化）。</p>
        )}
      </div>

      {/* 修不了的问题必须显眼：这是「只改两种机械变换」承诺的代价 */}
      <div className="tc-repair-block tc-repair-unrepairable">
        <h4 className="tc-repair-block-title">
          <AlertTriangle size={15} aria-hidden="true" />
          修不了的问题（{unrepairable.length} 条）
        </h4>
        {unrepairable.length > 0 ? (
          <>
            <p className="tc-hint">
              这些不在机械修复范围内——修复器不会猜、也不会悄悄改掉；确认写入后它们仍然存在，需要你人工判断或补数据。
            </p>
            <ul className="tc-repair-unrep-list">
              {unrepairable.map((item, index) => (
                <li key={`${item.ruleId}-${item.day ?? 0}-${index}`}>
                  <code className="tc-rule-id">{item.ruleId}</code>
                  <span className="tc-repair-unrep-title">{ruleTitle(item.ruleId)}</span>
                  {(item.day !== undefined || item.spot) && (
                    <span className="tc-repair-unrep-loc">
                      {[item.day !== undefined ? `第 ${item.day} 天` : "", item.spot ?? ""]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  )}
                  <p className="tc-repair-unrep-reason">{item.reason}</p>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="tc-hint">没有需要修复器处理的残留问题。</p>
        )}
      </div>

      <div className="tc-repair-cred">
        <h4 className="tc-repair-block-title">凭据链（确认后写入历史）</h4>
        <div className="tc-repair-cred-row">
          <span className="tc-repair-cred-label">修复前</span>
          <code className="tc-repair-cred-id" data-testid="tc-ws-check-parent-credential">
            {preview.parentCredential.id}
          </code>
        </div>
        <div className="tc-repair-cred-row">
          <span className="tc-repair-cred-label">修复后</span>
          <code className="tc-repair-cred-id" data-testid="tc-ws-check-repair-credential">
            {preview.credential.id}
          </code>
        </div>
        <p className="tc-repair-cred-note">
          前后两张凭据都可复算，能对账改了哪些；确认后它们会作为修复历史挂在行程上。
        </p>
      </div>

      {changed ? (
        <div className="tc-ws-check-confirm">
          <button
            type="button"
            className="btn btn-primary tc-ws-check-confirm-btn"
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? (
              <Loader2 size={15} className="spin" aria-hidden="true" />
            ) : (
              <Check size={15} aria-hidden="true" />
            )}
            {confirming ? "正在写入…" : `确认写入${nextVersion}`}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={confirming}>
            放弃预览
          </button>
          <p className="tc-hint">
            确认后生成新 revision（persisted=true）；分享页与后续访问会读到新版本。预览本身不写库。
          </p>
        </div>
      ) : (
        <p className="tc-hint">没有可写入的变更，不会产生新版本（persisted=false）。</p>
      )}
    </div>
  );
}

function RepairHistory({ meta }: { meta: PlanTripCheckMeta | null }) {
  return (
    <section className="tc-ws-check-history" aria-labelledby="tc-ws-check-history-title">
      <div className="tc-ws-check-history-head">
        <h3 id="tc-ws-check-history-title">修复历史（只读）</h3>
        <span className="tc-axis-note">来自已持久化行程 · 没有记录就不显示数字</span>
      </div>
      {meta ? (
        <dl className="tc-ws-check-history-grid">
          <div>
            <dt>累计确定性修复</dt>
            <dd>{meta.repairCount !== undefined ? `${meta.repairCount} 次` : "未记录"}</dd>
          </div>
          <div>
            <dt>最近修复时间</dt>
            <dd>{meta.repairedAt !== undefined ? formatMillis(meta.repairedAt) : "未记录"}</dd>
          </div>
          <div>
            <dt>最近应用</dt>
            <dd>{meta.applied !== undefined ? `${meta.applied} 处机械变换` : "未记录"}</dd>
          </div>
          <div>
            <dt>最近凭据</dt>
            <dd className="tc-mono" data-testid="tc-ws-check-history-credential">
              {meta.credentialId}
            </dd>
          </div>
          {meta.parentCredentialId && (
            <div>
              <dt>父凭据（链）</dt>
              <dd className="tc-mono">{meta.parentCredentialId}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="tc-hint">
          还没有已确认写入的修复记录。体检本身不改动行程、也不会产生历史；预览同样不写库。
        </p>
      )}
    </section>
  );
}

export function WorkspaceCheck({
  plan,
  shareId,
  onPlanChange,
}: {
  plan: Plan;
  shareId: string;
  onPlanChange: (plan: Plan) => void;
}) {
  const [checking, setChecking] = useState(true);
  const [report, setReport] = useState<TripCheckReportData | null>(null);
  const [credential, setCredential] = useState<TripCheckCredential | null>(null);
  const [planRevision, setPlanRevision] = useState<number | null>(null);
  const [tripCheck, setTripCheck] = useState<PlanTripCheckMeta | null>(plan.tripCheck ?? null);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PlanRepairPreview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<WorkspaceCheckError | null>(null);
  const [success, setSuccess] = useState<{ revision?: number; applied: number } | null>(null);
  const checkToken = useRef(0);

  const busy = checking || previewing || confirming;

  const loadCheck = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const token = ++checkToken.current;
      if (!options.silent) setChecking(true);
      setError((prev) => (prev?.scope === "check" ? null : prev));
      try {
        const res = await fetch("/api/plan/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shareId }),
        });
        if (token !== checkToken.current) return;
        if (!res.ok) {
          setError(await errorOf(res, "check"));
          return;
        }
        const data = (await res.json()) as unknown;
        if (!isCheckResponse(data)) {
          setError({
            scope: "check",
            title: "响应格式不符合约定",
            message: "服务端返回的不是体检报告；请重试，或检查 /api/plan/check 是否已部署。",
          });
          return;
        }
        setReport(data.report);
        setCredential(data.credential);
        setPlanRevision(data.planRevision);
        setTripCheck(data.tripCheck);
      } catch {
        if (token !== checkToken.current) return;
        setError({
          scope: "check",
          title: "网络错误：没收到响应",
          message: "请检查网络后重试；如果接口没启动或被代理拦截，体检会不可用。",
        });
      } finally {
        if (token === checkToken.current) setChecking(false);
      }
    },
    [shareId],
  );

  useEffect(() => {
    // 挂载即体检：这是与外部系统（/api/plan/check）同步，不是从 props 派生 state；
    // 数据回来后的 setState 是异步的，只有请求发起前的检查态需要同步置位。
    // eslint-disable-next-line react/set-state-in-effect -- 挂载即拉取外部报告
    void loadCheck();
  }, [loadCheck]);

  const loadPreview = useCallback(async () => {
    if (previewing || confirming) return;
    setPreviewing(true);
    setPreview(null);
    setSuccess(null);
    setError((prev) => (prev?.scope === "check" ? prev : null));
    try {
      const res = await fetch("/api/plan/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shareId, confirm: false }),
      });
      if (!res.ok) {
        setError(await errorOf(res, "repair"));
        return;
      }
      const data = (await res.json()) as unknown;
      if (!isRepairPreview(data)) {
        setError({
          scope: "repair",
          title: "响应格式不符合约定",
          message: "服务端返回的不是修复预览；请重试，或检查 /api/plan/repair 是否已部署。",
        });
        return;
      }
      setPreview(data);
    } catch {
      setError({
        scope: "repair",
        title: "网络错误：没收到响应",
        message: "修复预览没有收到响应，请检查网络后重试；行程内容未被修改。",
      });
    } finally {
      setPreviewing(false);
    }
  }, [previewing, confirming, shareId]);

  const confirmRepair = useCallback(async () => {
    if (!preview || !preview.changed || confirming) return;
    setConfirming(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { shareId, confirm: true };
      if (planRevision !== null) body.expectedRevision = planRevision;
      const res = await fetch("/api/plan/repair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await errorOf(res, "confirm"));
        return;
      }
      const data = (await res.json()) as unknown;
      if (!isConfirmResponse(data)) {
        setError({
          scope: "confirm",
          title: "响应格式不符合约定",
          message: "服务端没有返回可识别的写入结果；请刷新体检确认行程版本后再决定是否重试。",
        });
        return;
      }
      if (!data.persisted || !data.changed) {
        setPreview(null);
        setError({
          scope: "confirm",
          title: "没有写入任何内容",
          message:
            "服务端返回 changed=false / persisted=false：这份行程没有可机械修复的变更，未产生新版本。行程内容未被修改。",
        });
        return;
      }
      if (data.plan && isPlan(data.plan)) onPlanChange(data.plan);
      setSuccess({
        revision: data.revision,
        applied: data.applied?.length ?? preview.applied.length,
      });
      setPreview(null);
      // 写入成功后刷新体检：报告、revision 与修复历史都以服务端为准，不本地拼
      void loadCheck({ silent: true });
    } catch {
      setError({
        scope: "confirm",
        title: "网络错误：没收到响应",
        message: "写入可能没有完成。请刷新体检确认当前版本与修复历史后，再决定是否重新预览。",
      });
    } finally {
      setConfirming(false);
    }
  }, [preview, confirming, shareId, planRevision, onPlanChange, loadCheck]);

  return (
    <section className="tc-ws-check" aria-labelledby="tc-ws-check-title" aria-busy={busy}>
      <header className="tc-ws-check-head">
        <div className="tc-ws-check-head-main">
          <p className="tc-report-eyebrow">Trip Check · 体检镜头</p>
          <h2 className="tc-ws-check-title" id="tc-ws-check-title">
            这份行程能不能照着走
          </h2>
          <p className="tc-ws-check-lede">
            两轴分开看：结构自洽性只靠文档判断，事实核验看来源覆盖与三态。每条问题都带规则
            ID、可对账证据与修复方向；确定性修复先预览、确认后才写入新版本。页头的「可执行性」
            分数含事实问题扣分，本页的结构等级只反映行程自身是否自洽——两者不是同一个口径。
          </p>
        </div>
        <div className="tc-ws-check-actions">
          <Link
            href={`/verify?share=${encodeURIComponent(shareId)}`}
            target="_blank"
            rel="noreferrer"
            className="btn"
          >
            在开放体检台查看 →
          </Link>
          <button type="button" className="btn" onClick={() => void loadCheck()} disabled={busy}>
            <RefreshCw size={14} aria-hidden="true" />
            {checking ? "刷新中…" : "刷新体检"}
          </button>
        </div>
      </header>

      {error?.scope === "check" && !report && (
        <ErrorBox error={error} onRetry={() => void loadCheck()} retryLabel="重试体检" />
      )}

      {checking && !report && (
        <p className="tc-ws-check-state" role="status" aria-live="polite">
          <Loader2 size={15} className="spin" aria-hidden="true" />
          正在读取行程并跑确定性体检…
        </p>
      )}

      {error?.scope === "check" && report && (
        <ErrorBox error={error} onRetry={() => void loadCheck()} retryLabel="重试体检" />
      )}

      {report && credential && (
        <>
          <CheckEvidence report={report} credential={credential} shareId={shareId} />

          <section
            className="tc-repair card tc-ws-check-repair"
            aria-labelledby="tc-ws-check-repair-title"
            aria-busy={previewing || confirming}
          >
            <div className="card-body">
              <div className="tc-repair-head">
                <h3 id="tc-ws-check-repair-title">确定性修复</h3>
                <span className="tc-axis-note">只顺延时间 / 删同日重复 · 不调模型</span>
              </div>
              <p className="tc-repair-lede">
                修复会改写这份行程：先预览改动与修不了的问题，确认后才写入新版本；不确认不会保存。
                修复器只做两种不改变行程语义的机械变换——顺延冲突/接不上的时间、删除同一天重复点位；
                不编造地点/营业时间/路段，也不替你换点或删独立点位。
              </p>

              {planRevision === null ? (
                <p className="tc-hint tc-ws-check-readonly">
                  这条链接是旧版分享（只读），没有可写入的版本号，不支持修复；请打开新生成的行程再操作。
                  体检报告仍然有效。
                </p>
              ) : (
                !preview && (
                  <div className="tc-repair-actions">
                    <button
                      type="button"
                      className="btn btn-primary tc-repair-btn"
                      onClick={() => void loadPreview()}
                      disabled={previewing || confirming || checking}
                    >
                      {previewing ? (
                        <Loader2 size={15} className="spin" aria-hidden="true" />
                      ) : (
                        <Wand2 size={15} aria-hidden="true" />
                      )}
                      {previewing ? "正在生成预览…" : "先预览修复"}
                    </button>
                    <p className="tc-hint">
                      预览不写库（persisted=false）；确认才会生成新版本。修不了的问题会在预览里逐条列出。
                    </p>
                  </div>
                )
              )}

              {(previewing || preview) && (
                <p className="tc-status" role="status" aria-live="polite">
                  {previewing ? "正在计算确定性修复并重新体检…" : ""}
                </p>
              )}

              {error?.scope === "repair" && (
                <ErrorBox error={error} onRetry={() => void loadPreview()} retryLabel="重新预览" />
              )}

              {preview && (
                <RepairPreviewBlock
                  preview={preview}
                  planRevision={planRevision}
                  confirming={confirming}
                  onConfirm={() => void confirmRepair()}
                  onCancel={() => {
                    setPreview(null);
                    setError(null);
                  }}
                />
              )}

              {error?.scope === "confirm" && (
                <ErrorBox
                  error={error}
                  onRetry={() => {
                    setPreview(null);
                    setSuccess(null);
                    void loadCheck();
                  }}
                  retryLabel={
                    error.conflictRevision !== undefined ? "刷新体检后重新预览" : "刷新体检"
                  }
                />
              )}

              {success && (
                <div className="tc-ws-check-notice" role="status">
                  <Check size={16} aria-hidden="true" />
                  <div>
                    <p>
                      <b>
                        已写入
                        {success.revision !== undefined ? `第 ${success.revision} 版` : "新版本"}
                      </b>
                      （persisted=true）· 应用 {success.applied} 处确定性修复。
                    </p>
                    <p>
                      分享页与后续访问会读到新版本；修复历史见下方「修复历史（只读）」，以服务端记录为准。
                    </p>
                  </div>
                </div>
              )}
            </div>
          </section>

          <RepairHistory meta={tripCheck} />

          <section className="tc-honesty" aria-labelledby="tc-ws-check-honesty-title">
            <h3 id="tc-ws-check-honesty-title">这份体检与修复的边界</h3>
            <ul>
              <li>
                <b>体检只判定、不修改：</b>
                报告不会改动行程；任何修改都必须先预览、再确认写入新版本。
              </li>
              <li>
                <b>修复只做两种机械变换：</b>
                顺延冲突/接不上的时间、删除同一天重复点位（保留第一条）；不编造地点/营业时间/路段。
              </li>
              <li>
                <b>修不了的问题照实列在预览里：</b>
                缺数据、闭馆/营业时间不符、预算与节奏等涉及取舍的问题，修复器不猜、不悄悄改。
              </li>
              <li>
                <b>不写回分享行程除非确认：</b>
                预览 persisted=false；确认后生成新 revision，分享页读到新版本。
              </li>
              <li>
                <b>分享页只读：</b>分享页展示已持久化的行程与凭据，不能在那里执行修复。
              </li>
              <li>
                <b>未核验 ≠ 没问题：</b>
                事实核验取决于文档声明的来源；没核到的地方是「不知道」，不是「没问题」。MOCK
                数据不冒充真实核验。
              </li>
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
