// ============================================================
// Trip Check CLI 的终端输出（纯函数，无 IO）
//
// 为什么单独拆成纯函数：CLI 的「人读输出」是这个工具的门面，必须能用 vitest
// 直接断言（color=false 时的纯文本），不能让格式逻辑混在 fs/argv 里测不到。
// 颜色只在这一层处理；NO_COLOR / 非 TTY 由调用方折算成 color=false 传进来。
// ============================================================

import type { FactsVerdict, RepairResult, TripCheckReport, VerifyIssue } from "../lib/verify/types";

export interface FormatOptions {
  color: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

function paint(color: boolean, code: keyof typeof ANSI, text: string): string {
  return color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
}

/** 严重度展示顺序与图标：阻断在前，提示在最后（终端里人从上往下读） */
const SEVERITY_META = {
  blocking: { icon: "✗", label: "阻断", color: "red" as const },
  warning: { icon: "!", label: "提醒", color: "yellow" as const },
  info: { icon: "i", label: "提示", color: "cyan" as const },
};

const GRADE_COLOR = { A: "green", B: "green", C: "yellow", D: "red" } as const;

const FACTS_STATE_LABEL: Record<FactsVerdict["state"], string> = {
  verified: "全部核验",
  partial: "部分核验",
  unverified: "未核验",
  inconclusive: "无可核验内容",
};

const OVERALL_LABEL: Record<TripCheckReport["verdict"]["overall"], string> = {
  ok: "可以照着走",
  warnings: "能走，但有要小心的地方",
  blocking: "有走不通的地方",
  unverified: "结构没问题，但事实没核过",
};

function formatIssue(issue: VerifyIssue, opts: FormatOptions): string[] {
  const meta = SEVERITY_META[issue.severity];
  const head = paint(
    opts.color,
    meta.color,
    `${meta.icon} [${meta.label}] ${issue.ruleId} ${issue.title}`,
  );
  const lines = [`  ${head}`, `      ${issue.detail}`];
  if (issue.suggestion) lines.push(`      建议：${issue.suggestion}`);
  else if (issue.fixHint) lines.push(`      修复方向：${issue.fixHint}`);
  return lines;
}

function formatFacts(facts: FactsVerdict): string {
  const c = facts.coverage;
  const parts = [`POI ${c.poiHit}/${c.poiTotal} 命中`];
  if (c.poiMiss > 0) parts.push(`查无 ${c.poiMiss}`);
  if (c.poiError > 0) parts.push(`查询失败 ${c.poiError}`);
  if (c.poiNotChecked > 0) parts.push(`未查 ${c.poiNotChecked}`);
  parts.push(`营业时间 ${c.hoursChecked} 处`);
  parts.push(`路段 ${c.routesChecked}/${c.routesTotal}`);
  return parts.join(" · ");
}

/** 人读版报告（多行文本，末尾不带换行） */
export function formatReport(report: TripCheckReport, opts: FormatOptions): string {
  const { verdict } = report;
  const out: string[] = [];

  out.push(
    paint(
      opts.color,
      "dim",
      `trip-check ${report.engine.version} · 规则集 ${report.engine.rulesetVersion} · 规范 ${report.specVersion}`,
    ),
  );
  out.push("");

  const doc = report.document;
  const docParts = [doc.city ?? "(未标注城市)", `${doc.days} 天`, `${doc.spots} 个点位`];
  if (doc.budgetCny !== undefined) docParts.push(`预算 ¥${doc.budgetCny}/人`);
  out.push(paint(opts.color, "bold", docParts.join(" · ")));
  out.push("");

  const gradeColor = GRADE_COLOR[verdict.consistency.grade];
  out.push(
    `结构自洽性  ${paint(opts.color, gradeColor, `${verdict.consistency.grade} · ${verdict.consistency.score}/100`)}  ${verdict.consistency.summary}`,
  );
  out.push(
    `事实核验    ${paint(opts.color, verdict.facts.state === "verified" ? "green" : verdict.facts.state === "unverified" ? "yellow" : "cyan", FACTS_STATE_LABEL[verdict.facts.state])}  ${formatFacts(verdict.facts)}`,
  );
  out.push("");

  if (report.issues.length > 0) {
    const s = report.stats;
    out.push(
      paint(
        opts.color,
        "bold",
        `问题 ${s.total} 条（阻断 ${s.blocking} · 提醒 ${s.warnings} · 提示 ${s.infos}）`,
      ),
    );
    const ordered = (["blocking", "warning", "info"] as const).flatMap((sev) =>
      report.issues.filter((i) => i.severity === sev),
    );
    for (const issue of ordered) out.push(...formatIssue(issue, opts));
    out.push("");
  }

  const overallColor =
    verdict.overall === "ok" ? "green" : verdict.overall === "blocking" ? "red" : "yellow";
  out.push(
    `总评  ${paint(opts.color, overallColor, OVERALL_LABEL[verdict.overall])} —— ${verdict.summary}`,
  );

  if (report.credential) {
    out.push("");
    out.push(`凭据  ${paint(opts.color, "cyan", report.credential.id)}  （同一文档+口径可复算）`);
    out.push(paint(opts.color, "dim", `      input sha256: ${report.credential.inputHash}`));
    out.push(paint(opts.color, "dim", `      口径: ${report.credential.basis}`));
  }

  return out.join("\n");
}

/** 人读版修复结果（--fix）：改了什么、修不了什么、前后两张凭据 */
export function formatRepair(result: RepairResult, opts: FormatOptions): string {
  const out: string[] = [];

  out.push(paint(opts.color, "bold", `确定性修复 ${result.applied.length} 处`));
  if (result.applied.length === 0) {
    out.push("  没有可机械修复的问题（修不了的见下，或本来就没问题）。");
  }
  for (const a of result.applied) {
    out.push(`  · ${a.detail}`);
  }
  out.push("");

  if (result.unrepairable.length > 0) {
    out.push(paint(opts.color, "yellow", `修不了 ${result.unrepairable.length} 条（需人工）`));
    for (const u of result.unrepairable) {
      const where = [u.day ? `第 ${u.day} 天` : null, u.spot ? `「${u.spot}」` : null]
        .filter(Boolean)
        .join(" ");
      out.push(`  · ${u.ruleId}${where ? ` ${where}` : ""}：${u.reason}`);
    }
    out.push("");
  }

  const before = result.before;
  const after = result.after;
  const d = result.delta;
  const gradeOf = (r: TripCheckReport) =>
    `${r.verdict.consistency.grade} · ${r.verdict.consistency.score}`;
  const beforeId = before.credential?.id ?? "(无凭据)";
  const afterId = after.credential?.id ?? "(无凭据)";
  const deltaText = d.improved
    ? paint(
        opts.color,
        "green",
        `↑ 分 ${d.score >= 0 ? "+" : ""}${d.score} · 阻断 -${d.blockingReduced} · ${d.gradeFrom} → ${d.gradeTo}`,
      )
    : paint(opts.color, "dim", "没有实质改善（不建议应用这次修复）");

  out.push(
    `修复前  ${paint(opts.color, "dim", beforeId)}（${gradeOf(before)}）\n修复后  ${paint(opts.color, "cyan", afterId)}（${gradeOf(after)}）  ${deltaText}`,
  );

  return out.join("\n");
}

/**
 * 退出码语义（写进 README，CI 依赖它）：
 * - 0：ok / warnings（默认口径下 warnings 不算失败——它是「能走但留意」）
 * - 1：blocking（有走不通的地方）；--strict 时 warnings/unverified 也算失败
 * - 2：用法/输入非法（由调用方直接返回，不经过这里）
 */
export function exitCodeFor(report: TripCheckReport, strict: boolean): 0 | 1 {
  const overall = report.verdict.overall;
  if (overall === "blocking") return 1;
  if (strict && (overall === "warnings" || overall === "unverified")) return 1;
  return 0;
}
