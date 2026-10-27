import type { Plan } from "./types";
import { executabilityOf } from "./executability";

// ============================================================
// 「改一次，验一次」的效果对比（产品线 A4）
//
// 为什么需要：竞品调研里「不可修改」是 AI 行程的头号差评之一；我们已经有
// 换一个 / 一句话改 / 一键顺延 / 一键修复，但用户改完之后**看不出改好没好**——
// 风险从几条降到几条、可执行性从 B 到 A，全靠自己再翻一遍。
//
// 这个模块把「改动前后的可执行性」算成一句话，修复/顺延成功后展示：
// 「本次修复：可执行性 B(85) → A(92)，体检问题 3 → 1」。
//
// 三条红线：
// 1. 数字全部复用 lib/executability.ts（与评分卡同源），不另算一套；
// 2. **变差也要如实说**：不是所有改动都会降低风险，禁止只报喜；
// 3. MOCK/未核验的行程不给分数（没核过就没有「风险变化」可言），只报问题条数。
// ============================================================

export type ChangeKind = "adjust" | "refine";

export interface ChangeImpact {
  kind: ChangeKind;
  /** null = 未核验/生成中，不评假分 */
  scoreBefore: number | null;
  scoreAfter: number | null;
  gradeBefore: string | null;
  gradeAfter: string | null;
  warningsBefore: number;
  warningsAfter: number;
  /** 一句话人话结论（含「变差」的诚实分支） */
  summary: string;
}

function labelOf(score: number | null, grade: string | null): string {
  return score === null || grade === null ? "未核验" : `${grade}(${score})`;
}

export function changeImpact(before: Plan, after: Plan, kind: ChangeKind): ChangeImpact {
  const b = executabilityOf(before);
  const a = executabilityOf(after);
  const warningsBefore = before.warnings?.length ?? 0;
  const warningsAfter = after.warnings?.length ?? 0;

  let summary: string;
  if (b.score === null || a.score === null) {
    // 未核验/生成中：只报体检问题条数，不伪造「风险变化」
    summary = `本次修改后，体检问题 ${warningsBefore} → ${warningsAfter} 条（未接高德核验，无法评估风险变化）`;
  } else {
    const delta = a.score - b.score;
    const head = `可执行性 ${labelOf(b.score, b.grade)} → ${labelOf(a.score, a.grade)}`;
    if (delta > 0) {
      summary = `本次修复：${head}（+${delta}），体检问题 ${warningsBefore} → ${warningsAfter} 条`;
    } else if (delta === 0) {
      // 分数没变不等于没做事：问题条数可能变了，也可能只是换了个等价方案
      summary =
        warningsAfter === warningsBefore
          ? `本次修改：${head}（风险未变化），体检问题仍为 ${warningsAfter} 条`
          : `本次修改：${head}（风险未变化），体检问题 ${warningsBefore} → ${warningsAfter} 条`;
    } else {
      // 诚实：改动可能带来新的冲突（比如换的点位通勤更远）
      summary = `注意：${head}（${delta}），体检问题 ${warningsBefore} → ${warningsAfter} 条——这次改动没有让行程更稳，可再调一次`;
    }
  }

  return {
    kind,
    scoreBefore: b.score,
    scoreAfter: a.score,
    gradeBefore: b.grade,
    gradeAfter: a.grade,
    warningsBefore,
    warningsAfter,
    summary,
  };
}
