import type { Plan } from "../../lib/types";
import { parseTimeRange } from "../../lib/plan/time";
import { planToDocument } from "../../lib/verify/adapt";
import { verifyDocument } from "../../lib/verify/engine";

export function measurePlan(
  plan: Plan,
  expectedDays: number,
  input: { budget: number; startAt: string; endAt: string },
) {
  const report = verifyDocument({ ...planToDocument(plan), budgetCny: input.budget });
  const plannedDays = plan.days.filter((day) => day.spots.length > 0).map((day) => day.day);
  const complete =
    plannedDays.length === expectedDays && plannedDays.every((day, index) => day === index + 1);
  // 流式快照可能尚未执行全程费用汇总，按已经展示的站点计算同口径金额。
  const visibleCostCny = plan.days.reduce(
    (total, day) => total + day.spots.reduce((cost, spot) => cost + spot.costCny, 0),
    0,
  );
  const budgetPercent = input.budget > 0 ? Math.round((visibleCostCny / input.budget) * 100) : null;
  const minutesOf = (dateTime: string) =>
    Number(dateTime.slice(11, 13)) * 60 + Number(dateTime.slice(14, 16));
  const start = minutesOf(input.startAt);
  const end = minutesOf(input.endAt);
  let windowViolations = 0;
  let windowUnknown = 0;
  for (const day of plan.days) {
    if (day.day !== 1 && day.day !== expectedDays) continue;
    for (const spot of day.spots) {
      const range = parseTimeRange(spot.time);
      if (!range) {
        windowUnknown++;
      } else if (
        (day.day === 1 && range.start < start) ||
        (day.day === expectedDays && range.end > end)
      ) {
        windowViolations++;
      }
    }
  }
  const issueCounts: Record<string, number> = {};
  for (const issue of report.issues) {
    issueCounts[issue.ruleId] = (issueCounts[issue.ruleId] ?? 0) + 1;
  }
  return {
    plannedDays,
    complete,
    spotCount: plan.days.reduce((total, day) => total + day.spots.length, 0),
    visibleCostCny,
    budgetPercent,
    windowViolations,
    windowUnknown,
    consistencyScore: report.verdict.consistency.score,
    structureBlockers: report.issues.filter(
      (issue) => issue.category === "consistency" && issue.severity === "blocking",
    ).length,
    factsState: report.verdict.facts.state,
    issueCounts,
    coverage: report.verdict.facts.coverage,
    verification: plan.verification ?? null,
  };
}
