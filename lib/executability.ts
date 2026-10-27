import type { Plan } from "./types";
import { warnTag } from "./warn-tag";

// ============================================================
// 可执行性评分：把「体检结论」压成一个用户能一眼看懂、可展开看证据的结论
//
// 为什么需要（2026-10 产品调研结论）：竞品都在宣传「验真/权威数据」，但我们
// 真正的差异化是「验完之后告诉你这条行程走不走得通」——这个结论原来散在
// warnings 数组、验真徽章、核验报告三处，用户在首屏看不到。这里把它收敛成
// 一个确定性、可解释的评分卡：A/B/C/D + 分数 + 阻断项 + 证据。
//
// 设计取舍：
// - **确定性纯函数**：同样的 plan 永远同样分数，不调模型、可单测、可复现。
// - **扣分表显式可审计**：每一类问题值多少分写在 TAG_PENALTY 里，前端展示的
//   「2 条时间轴」能对上总分，不做黑箱加权。
// - **MOCK/草稿不评分**：没核验过的数据打 A 是骗人；生成中的半成品打 D 也不
//   公平。分别给「未核验」「核验中」状态，UI 不渲染假分数。
// ============================================================

export type ExecutabilityGrade = "A" | "B" | "C" | "D";

export type ExecutabilityState = "scored" | "pending" | "unverified";

export interface ExecutabilityIssue {
  /** 与 lib/warn-tag.ts 的标签一致（时间轴/营业/绕路…） */
  tag: string;
  /** 给用户看的短标签 */
  label: string;
  count: number;
  /** 这一类问题扣掉的分数（已按上限截断） */
  points: number;
}

export interface ExecutabilityReport {
  state: ExecutabilityState;
  /** scored 时 0-100；其它状态为 null（不评假分） */
  score: number | null;
  grade: ExecutabilityGrade | null;
  gradeLabel: string;
  /** 一句话结论：给首屏直接展示 */
  summary: string;
  totalSpots: number;
  verifiedSpots: number;
  unverifiedSpots: number;
  realLegs: number;
  totalWarnings: number;
  /** 会直接影响行程的硬问题条数（时间接不上/营业对不上/活动/无覆盖） */
  hardIssues: number;
  categories: ExecutabilityIssue[];
  groundedCandidates: number;
  closedSkipped: number;
  checkedAt?: number;
}

/** 标签 → 用户可读名称 */
const TAG_LABEL: Record<string, string> = {
  时间轴: "时间接不上",
  营业: "营业/闭馆",
  未验真: "未验真",
  覆盖: "目的地无覆盖",
  活动: "重点活动",
  绕路: "绕路",
  分散: "点位分散",
  节奏: "节奏偏满",
  预算: "预算偏差",
  系统: "数据波动",
};

/**
 * 扣分表：points = 单条扣分；hard = 会直接影响行程（否则只是提醒）。
 * 每类最多扣 TAG_CAP 分：10 条「未验真」不该把分数扣穿，但也不能当没看见。
 */
const TAG_PENALTY: Record<string, { points: number; hard?: boolean }> = {
  时间轴: { points: 15, hard: true },
  营业: { points: 15, hard: true },
  覆盖: { points: 12, hard: true },
  未验真: { points: 10 },
  活动: { points: 8, hard: true },
  绕路: { points: 8 },
  节奏: { points: 6 },
  分散: { points: 5 },
  预算: { points: 3 },
  系统: { points: 2 },
};
const TAG_CAP = 30;

// 等级文案的取向：诚实但不说「不合格」——AI 生成的行程本来就需要修，
// 我们的价值是「把问题标出来并且能一键修」。所以 D 用「待优化」而不是
// 「风险很高」，C 用「需微调」；证据链在展开区里完整对账，不粉饰。
const GRADE_LABEL: Record<ExecutabilityGrade, string> = {
  A: "可执行",
  B: "基本可执行",
  C: "需微调",
  D: "待优化",
};

function gradeOf(score: number): ExecutabilityGrade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}

function baseCounts(plan: Plan) {
  const spots = plan.days.flatMap((d) => d.spots);
  const totalSpots = spots.length;
  // location 由验真命中回填（见 lib/validate.ts）；没有坐标 = 没核过存在性
  const verifiedSpots = spots.filter((s) => Boolean(s.location)).length;
  return {
    totalSpots,
    verifiedSpots,
    unverifiedSpots: totalSpots - verifiedSpots,
    realLegs: plan.days.reduce((n, d) => n + (d.legs?.length ?? 0), 0),
    totalWarnings: plan.warnings?.length ?? 0,
    groundedCandidates: plan.grounding?.candidates ?? 0,
    closedSkipped: plan.grounding?.closedSkipped ?? 0,
  };
}

/**
 * 计算一份行程的可执行性结论。
 *
 * @param plan 只读行程（不修改传入对象）
 */
export function executabilityOf(plan: Plan): ExecutabilityReport {
  const counts = baseCounts(plan);
  const verification = plan.verification ?? (plan.verified ? "ok" : "mock");
  const common = {
    ...counts,
    checkedAt: plan.verifiedAt,
    categories: [] as ExecutabilityIssue[],
    hardIssues: 0,
  };

  // 1) 生成中的草稿：不评分（半成品打 D 会误导；打 A 更是骗人）
  if (plan.draft || verification === "pending") {
    return {
      state: "pending",
      score: null,
      grade: null,
      gradeLabel: "核验中",
      summary: "行程生成中，核验完成后给出可执行性结论。",
      ...common,
    };
  }

  // 2) MOCK / 未核验：不给分数，明确说清「需要自行确认」
  if (verification === "mock" || !plan.verified) {
    return {
      state: "unverified",
      score: null,
      grade: null,
      gradeLabel: "未核验",
      summary:
        "这份行程没有调用高德核验（演示/离线数据），POI 是否存在、营业时间是否合适都需要你自行确认。",
      ...common,
    };
  }

  // 3) 已核验：按体检问题分类扣分
  const tagCounts = new Map<string, number>();
  for (const w of plan.warnings ?? []) {
    const tag = warnTag(w);
    if (tag) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const categories: ExecutabilityIssue[] = [...tagCounts.entries()]
    .map(([tag, count]) => ({
      tag,
      label: TAG_LABEL[tag] ?? tag,
      count,
      points: Math.min((TAG_PENALTY[tag]?.points ?? 4) * count, TAG_CAP),
    }))
    .sort((a, b) => b.points - a.points);

  const score = Math.max(0, Math.min(100, 100 - categories.reduce((n, c) => n + c.points, 0)));
  const grade = gradeOf(score);
  const hardIssues = categories
    .filter((c) => TAG_PENALTY[c.tag]?.hard)
    .reduce((n, c) => n + c.count, 0);

  // 一句话结论：先回答「能不能照着走」，再给证据；不堆术语
  const parts: string[] = [];
  if (hardIssues > 0) {
    const top = categories
      .filter((c) => TAG_PENALTY[c.tag]?.hard)
      .slice(0, 2)
      .map((c) => `${c.label} ${c.count} 处`)
      .join("、");
    parts.push(`有 ${hardIssues} 处会直接影响行程：${top}（工作台可一键修复）`);
  } else if (counts.unverifiedSpots > 0) {
    parts.push(`没有阻断问题，但还有 ${counts.unverifiedSpots} 个点位未核验`);
  } else {
    parts.push("体检未发现阻断问题");
  }
  if (verification === "partial") parts.push("部分点位因高德波动未核完");
  const summary = `${parts.join("；")}。`;

  return {
    state: "scored",
    score,
    grade,
    gradeLabel: GRADE_LABEL[grade],
    summary,
    ...common,
    categories,
    hardIssues,
  };
}

/** 核验时间的人类可读格式（固定上海时区，避免 SSR/CSR 时区不一致导致水合差异） */
export function formatCheckedAt(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}
