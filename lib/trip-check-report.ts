// ============================================================
// Trip Check 报告工件模型（纯函数 · client-safe）
//
// 为什么需要：判定引擎（engine.ts）产出的是**结构化报告**，而「可传播」需要三种
// 人话形态——分享页的一行结论、可复制的纯文本、竖版海报的字段集合。三者都从
// 同一份 report 推导（不各自再算一遍），保证海报/页面/API 说的永远是同一件事。
//
// 三条红线（与引擎同源）：
// 1. 只搬运 report 里已有的事实（等级/分数/覆盖/问题/凭据），不新增任何判断；
// 2. 「未核验 / 部分核验」如实呈现，facts 状态不会被海报美化成「已验证」；
// 3. 文本截断按字符数（Satori 不支持 line-clamp，见 poster route 注释）。
// ============================================================

import type { TripCheckReport, VerifyIssue } from "./verify/types";

const FACTS_STATE_LABEL: Record<string, string> = {
  verified: "已核验",
  partial: "部分核验",
  unverified: "未核验",
  inconclusive: "无可核验点位",
};

/** 一行结论（分享卡/列表/og 描述用） */
export function reportHeadline(report: TripCheckReport): string {
  const c = report.verdict.consistency;
  const facts = FACTS_STATE_LABEL[report.verdict.facts.state] ?? report.verdict.facts.state;
  const city = report.document.city ? `${report.document.city} ` : "";
  const stats = `${city}${report.document.days} 天 · 结构 ${c.grade}/${c.score} · 事实${facts}`;
  const flag =
    report.verdict.overall === "blocking"
      ? " · 有阻断问题"
      : report.verdict.overall === "warnings"
        ? " · 需微调"
        : report.verdict.overall === "unverified"
          ? " · 事实未核验"
          : " · 未发现阻断";
  return `${stats}${flag}`;
}

/** 问题分组的标题（与 UI 分组口径一致） */
export function issueGroupTitle(severity: VerifyIssue["severity"]): string {
  if (severity === "blocking") return "阻断问题（按文档数据走不通）";
  if (severity === "warning") return "需要微调（能走但要改）";
  return "信息不足（不是通过，是不知道）";
}

/**
 * 可复制的纯文本报告（分享/转发/存档用）。
 *
 * 为什么保留纯文本形态：微信/邮件/工单里粘贴 JSON 没人看，但一段结构化纯文本
 * 既能让对方读懂，也保留规则 ID 与凭据 ID 供复算。
 */
export function reportPlainText(
  report: TripCheckReport,
  options: { url?: string; credentialId?: string } = {},
): string {
  // 凭据由服务端签发（credentialOf），引擎报告本身不带；这里允许显式传入，
  // 也兼容「report.credential 已被附加」的调用方式。
  const credentialId = options.credentialId ?? report.credential?.id ?? "";
  const lines: string[] = [];
  lines.push(`行程体检报告 · Trip Check ${report.specVersion}`);
  lines.push(reportHeadline(report));
  lines.push("");
  lines.push(
    `结构自洽性：${report.verdict.consistency.grade}（${report.verdict.consistency.score}/100）· ${report.verdict.consistency.summary}`,
  );
  lines.push(`事实核验：${report.verdict.facts.summary}`);
  const c = report.verdict.facts.coverage;
  lines.push(
    `覆盖：地点 ${c.poiChecked}/${c.poiTotal}（命中 ${c.poiHit} / 未命中 ${c.poiMiss} / 查询失败 ${c.poiError} / 未查 ${c.poiNotChecked}）· 营业时间 ${c.hoursChecked}/${c.poiTotal} · 真实路段 ${c.routesChecked}/${c.routesTotal}`,
  );
  const groups: Array<VerifyIssue["severity"]> = ["blocking", "warning", "info"];
  for (const severity of groups) {
    const items = report.issues.filter((i) => i.severity === severity);
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`${issueGroupTitle(severity)}（${items.length}）`);
    for (const issue of items) {
      lines.push(`- [${issue.ruleId}] ${issue.detail}`);
      if (issue.suggestion) lines.push(`  建议：${issue.suggestion}`);
      if (issue.fixHint) lines.push(`  方向：${issue.fixHint}`);
    }
  }
  lines.push("");
  if (credentialId) {
    lines.push(
      `凭据：${credentialId}（引擎 ${report.engine.version} · 规则集 ${report.engine.rulesetVersion} · 可复算，不是签名）`,
    );
  }
  lines.push(`判定时间：${report.checkedAt}`);
  if (options.url) lines.push(`在线报告：${options.url}`);
  return lines.join("\n");
}

/** 竖版海报模型（ImageResponse/Satori 用；字段全部来自 report，不新增判断） */
export interface CheckPosterIssue {
  ruleId: string;
  title: string;
  detail: string;
}

export interface CheckPosterModel {
  city: string;
  daysText: string;
  dateText: string;
  headline: string;
  grade: string;
  gradeLabel: string;
  score: number;
  factsLabel: string;
  factsSummary: string;
  issues: CheckPosterIssue[];
  issueOverflow: number;
  credentialId: string;
  engineLine: string;
  brandLine: string;
  sourceLine: string;
  /** 核验时间（展示用，ISO） */
  checkedAt: string;
}

export function buildCheckPosterModel(
  report: TripCheckReport,
  options: { maxIssues?: number; credentialId?: string } = {},
): CheckPosterModel {
  const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const maxIssues = options.maxIssues ?? 4;
  const credentialId = options.credentialId ?? report.credential?.id ?? "";
  const important = report.issues
    .filter((i) => i.severity === "blocking" || i.severity === "warning")
    .slice(0, maxIssues);
  return {
    city: clamp(report.document.city ?? "行程", 12),
    daysText: `${report.document.days} 天行程`,
    dateText: "",
    headline: reportHeadline(report),
    grade: report.verdict.consistency.grade,
    gradeLabel: report.verdict.consistency.gradeLabel,
    score: report.verdict.consistency.score,
    factsLabel: FACTS_STATE_LABEL[report.verdict.facts.state] ?? report.verdict.facts.state,
    factsSummary: report.verdict.facts.summary,
    issues: important.map((i) => ({
      ruleId: i.ruleId,
      title: clamp(i.title, 10),
      detail: clamp(i.detail, 46),
    })),
    issueOverflow: Math.max(
      0,
      report.issues.filter((i) => i.severity === "blocking" || i.severity === "warning").length -
        important.length,
    ),
    credentialId,
    engineLine: `Trip Check ${report.specVersion} · 引擎 ${report.engine.version} · 规则集 ${report.engine.rulesetVersion}`,
    brandLine: "行程规划师 · 每一份行程，都经得起核验",
    sourceLine: "判定基于行程文档声明的事实来源；可复算，不是数字签名",
    checkedAt: report.checkedAt,
  };
}
