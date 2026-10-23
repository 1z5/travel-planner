// 预算透视：把「人均总花费」一个数字，拆成用户真正看得懂的三件事——
// 1) 预算使用率（超支 / 刚贴预算 / 达标 / 宽松），口径与 lib/validate.ts 的
//    预算预警阈值严格对齐（>105% 超支、<80% 宽松），两处不能说两套话；
// 2) 钱花在哪些类别（住宿 / 餐饮 / 景点门票 / 交通 / 购物 / 体验活动 / 其它）；
// 3) 一句人话结论（notes[0]），解释「是否超支、钱主要花在哪」。
//
// 纯函数 + 只 import type：结果页是客户端组件，直接 summarizeBudget(plan) 即可，
// 不能把这套逻辑放进 validate.ts（server-only）里再传下来。
//
// 诚实原则（本项目的产品底线）：
// - 没有预算字段 → status "unknown"，usedPct/largest 不猜，只讲实际构成；
// - 行程记录的总价与逐项合计不一致 → 以逐项合计为准（spot.costCny 才是明细来源），
//   并在 notes 里如实说明数据不一致，不掩盖；
// - budget 为 0 / 负数 / 非有限值 → 视为「无可用预算」，绝不除零出 Infinity/NaN。

import type { Plan, SpotType } from "./types";

/** 预算使用状态。阈值来源：lib/validate.ts 的 BUDGET_OVER=1.05 / BUDGET_UNDER=0.8 */
export type BudgetStatus = "unknown" | "over" | "tight" | "on-target" | "under";

/** 语义色档位：组件据此套 CSS 类（红 / 黄 / 绿 / 中性），lib 不产出具体 CSS */
export type BudgetTone = "ok" | "warn" | "err" | "muted";

/**
 * 分类键：行程 spot 的 6 个真实类型 + 未知类型的兜底「其它」。
 * 为什么允许 "other"：LLM 偶发输出未定义 type（旧数据也可能），
 * 直接丢掉会让「类别之和 ≠ 总花费」——那正是这个模块要避免的假账。
 */
export type CostCategoryType = SpotType | "other";

export interface CostCategoryMeta {
  type: CostCategoryType;
  label: string;
  /** 类别固定色（与 globals.css 里 type-* 徽章同一套色系，暗色底可读） */
  color: string;
}

/**
 * 固定类别与兜底顺序。颜色沿用设计系统 type-badge 的色系，让预算图例
 * 与时间线里的类型徽章是同一套颜色语言。lib 只给 key/label/color——
 * 图标属于组件层（服务端无关模块不必依赖 lucide）。
 */
export const COST_CATEGORIES: readonly CostCategoryMeta[] = [
  { type: "hotel", label: "住宿", color: "#c4b5fd" },
  { type: "food", label: "餐饮", color: "#fcd34d" },
  { type: "sight", label: "景点门票", color: "#7dd3fc" },
  { type: "transport", label: "交通", color: "#cbd5e1" },
  { type: "shopping", label: "购物", color: "#f9a8d4" },
  { type: "activity", label: "体验活动", color: "#6ee7b7" },
  { type: "other", label: "其它", color: "#a1a1aa" },
];

const OTHER_META: CostCategoryMeta = COST_CATEGORIES[COST_CATEGORIES.length - 1];
/** 类别展示顺序（同额时按这个顺序稳定排序，避免每次渲染图例乱跳） */
const CATEGORY_ORDER = new Map<string, number>(COST_CATEGORIES.map((c, i) => [c.type, i]));

function categoryMeta(type: string): CostCategoryMeta {
  return COST_CATEGORIES.find((c) => c.type === type) ?? OTHER_META;
}

/** 金额展示统一入口（组件与 notes 用同一个格式，避免「¥1,200」与「¥1200」混排） */
export function formatCny(n: number): string {
  const rounded = Math.round(Number.isFinite(n) ? n : 0);
  return `¥${rounded.toLocaleString("zh-CN")}`;
}

/** 状态 → 语义色档位。收敛在 lib，组件不再自己判断阈值。 */
export function budgetTone(status: BudgetStatus): BudgetTone {
  switch (status) {
    case "over":
      return "err";
    case "tight":
    case "under":
      return "warn";
    case "on-target":
      return "ok";
    default:
      return "muted";
  }
}

export interface BudgetCategory {
  type: CostCategoryType;
  label: string;
  /** 类别固定色（来自 COST_CATEGORIES，组件画图例/堆叠条用，保证两处同色） */
  color: string;
  amount: number; // 取整后的人均金额
  pct: number; // 占总额百分比（整数；所有类别 pct 之和恰好 100）
  count: number; // 该类别的行程条目数（含免费项——它确实被安排了，只是没花钱）
}

export interface BudgetDay {
  day: number;
  amount: number;
  /** 当天花费占预算百分比；无可用预算时 undefined（不猜） */
  pctOfBudget?: number;
}

export interface BudgetLargestCategory {
  type: CostCategoryType;
  label: string;
  amount: number;
  pct: number;
}

export interface BudgetSummary {
  total: number; // 实际人均总花费（= 各类别 amount 之和）
  budget?: number; // 用户预算（缺失/无效 = undefined）
  usedPct?: number; // total/budget*100，四舍五入
  status: BudgetStatus;
  categories: BudgetCategory[]; // 按 amount 降序，已剔除 0 元类别
  largest?: BudgetLargestCategory; // 占比最大类别（解释「钱主要花在哪」）
  notes: string[]; // 人话解释，最多 3 条，notes[0] 是结论
  perDay: BudgetDay[]; // 每日花费，供未来复用（如「哪天最贵」）
}

/**
 * 最大余数法把整数百分比补齐到 100。
 *
 * 为什么不用简单四舍五入：住宿 62.3% + 餐饮 22.1% + 门票 14.5% + 体验 1.0%
 * 逐项四舍五入会得到 62+22+15+1=100 只是运气；换一组数据就可能 99% 或 101%，
 * 图例上的百分比之和与「100%」自相矛盾，是肉眼可见的假数据。这里先取下界，
 * 再把差额按小数部分从大到小逐项 +1（余额 < 类别数，最多 6 次），
 * 保证非空类别 pct 之和恒为 100，且同额时按金额降序稳定分配。
 */
function allocatePcts(amounts: readonly number[], total: number): number[] {
  if (total <= 0) return amounts.map(() => 0);
  const raw = amounts.map((a) => (a / total) * 100);
  const pcts = raw.map((x) => Math.floor(x));
  let remaining = 100 - pcts.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    pcts[i] += 1;
    remaining -= 1;
  }
  // 理论不可达（类别数恒 ≤ 7，余数 < 类别数）；留兜底避免极端浮点让和不是 100
  for (let i = 0; remaining > 0; i = (i + 1) % pcts.length) {
    pcts[i] += 1;
    remaining -= 1;
  }
  return pcts;
}

function roundMoney(n: unknown): { amount: number; anomaly: boolean } {
  if (typeof n !== "number" || !Number.isFinite(n)) {
    // 非数字/NaN/Infinity 不能静默变 0 却假装数据正常——计入 anomaly，notes 里说明
    return { amount: 0, anomaly: true };
  }
  const rounded = Math.round(n);
  if (rounded < 0) return { amount: 0, anomaly: true };
  return { amount: rounded, anomaly: false };
}

/**
 * 汇总一份行程的预算透视。
 *
 * total 的口径是「逐项 costCny 取整后求和」——与 validate.ts 回填的
 * dailyCostCny/totalCostCny 同源（那边也是逐项求和），但这里不信任 plan 上
 * 可能过期的 totalCostCny：明细才是可解释的出处。
 */
export function summarizeBudget(plan: Plan): BudgetSummary {
  const days = Array.isArray(plan.days) ? plan.days : [];

  // 1) 逐天 / 逐类别累计。金额先取整再求和，避免 0.1+0.2 的浮点尾巴。
  const perType = new Map<string, { amount: number; count: number }>();
  const dayAmounts: number[] = [];
  let anomalyCount = 0;
  for (const day of days) {
    let dayAmount = 0;
    for (const spot of day?.spots ?? []) {
      const { amount, anomaly } = roundMoney(spot?.costCny);
      if (anomaly) anomalyCount += 1;
      const type = typeof spot?.type === "string" && spot.type ? spot.type : "other";
      const agg = perType.get(type) ?? { amount: 0, count: 0 };
      agg.amount += amount;
      agg.count += 1;
      perType.set(type, agg);
      dayAmount += amount;
    }
    dayAmounts.push(dayAmount);
  }

  // 2) 类别：剔 0 元类别（免费行程项不该在图例里占 0% 的位），按金额降序。
  const built = [...perType.entries()]
    .filter(([, agg]) => agg.amount > 0)
    .map(([type, agg]) => {
      const meta = categoryMeta(type);
      return {
        type: meta.type,
        label: meta.label,
        color: meta.color,
        amount: agg.amount,
        count: agg.count,
        order: CATEGORY_ORDER.get(meta.type) ?? CATEGORY_ORDER.size,
      };
    })
    .sort((a, b) => b.amount - a.amount || a.order - b.order);

  const total = built.reduce((s, c) => s + c.amount, 0);
  const pcts = allocatePcts(
    built.map((c) => c.amount),
    total,
  );
  const categories: BudgetCategory[] = built.map((c, i) => ({
    type: c.type,
    label: c.label,
    color: c.color,
    amount: c.amount,
    pct: pcts[i],
    count: c.count,
  }));
  const largest: BudgetLargestCategory | undefined = categories[0]
    ? {
        type: categories[0].type,
        label: categories[0].label,
        amount: categories[0].amount,
        pct: categories[0].pct,
      }
    : undefined;

  // 3) 预算使用率。0 预算是「穷游」的有效输入，不是无效值——只有负数/NaN
  //    才叫无效。区分开：穷游要给一句人话（只统计花费、不判达成），
  //    无效要说明「为什么没有使用率」。两者混成一句会把用户的选择说成故障。
  const rawBudget = plan.budgetCny;
  const budgetFilled = typeof rawBudget === "number" && Number.isFinite(rawBudget);
  const frugal = budgetFilled && rawBudget === 0;
  const budget = budgetFilled && rawBudget >= 1 ? Math.round(rawBudget) : undefined;
  let status: BudgetStatus = "unknown";
  let usedPct: number | undefined;
  if (budget !== undefined) {
    const ratio = total / budget; // 判定用未取整比值，与 validate.ts 的 1.05/0.8 完全同口径
    usedPct = Math.round(ratio * 100);
    if (ratio > 1.05) status = "over";
    // 100%~105% 算「刚贴预算」：没超 validate 的预警线，但已经比预算多花了。
    // 恰好 100%（ratio === 1）归 on-target——「刚好用满」是达标，不是超。
    else if (ratio > 1) status = "tight";
    else if (ratio >= 0.8) status = "on-target";
    else status = "under";
  }

  // 4) 人话结论：先讲预算（若有），再讲最大开销；数据问题最后如实补一句。
  const notes: string[] = [];
  if (budget === undefined) {
    // 没有预算就不下「超支/富余」的判断，只讲能讲的事实。
    // 预算填了但无效（0/负数）时，先说清「为什么没有使用率」，再讲最大开销。
    if (frugal) {
      notes.push("穷游模式：预算为 0，只统计实际花费，不做预算达成判断");
      if (largest) {
        notes.push(
          `${largest.label}占 ${largest.pct}%，是最大开销（人均 ${formatCny(largest.amount)}）`,
        );
      }
      if (total === 0) {
        notes.push("这份行程没有记录花费——与穷游预算一致，可能是免费景点为主");
      }
    } else if (budgetFilled) {
      notes.push(`预算金额 ${String(rawBudget)} 无效，无法计算使用率——以下为实际花费构成`);
      if (largest) {
        notes.push(
          `${largest.label}占 ${largest.pct}%，是最大开销（人均 ${formatCny(largest.amount)}）`,
        );
      }
    } else {
      // 无预算时 notes[0] 仍是「钱主要花在哪」——那是这份摘要里最有信息量的一句
      if (largest) {
        notes.push(
          `${largest.label}占 ${largest.pct}%，是最大开销（人均 ${formatCny(largest.amount)}）`,
        );
      }
      if (total === 0) {
        notes.push("这份行程没有记录花费，无法做预算透视（可能是免费行程或数据缺失）");
      } else {
        notes.push("未记录预算，无法计算使用率——以上为实际花费构成");
      }
    }
  } else if (total === 0) {
    // 有预算却 0 花费：说成「预算宽松」是误导，更可能是免费行程或数据缺失。
    notes.push(
      `行程没有记录花费（预算 ${formatCny(budget)} 未动用）——可能是免费景点为主，也可能是数据缺失`,
    );
  } else {
    const diff = total - budget;
    if (status === "over") {
      const overPct = Math.round((total / budget - 1) * 100);
      notes.push(
        `比预算多 ${formatCny(diff)}（+${overPct}%）——建议优先压缩${largest ? largest.label : "弹性项"}`,
      );
    } else if (status === "tight") {
      const overPct = Math.round((total / budget - 1) * 100);
      notes.push(`比预算多 ${formatCny(diff)}（+${overPct}%），刚贴上 105% 预警线——再花就超了`);
    } else if (status === "on-target") {
      notes.push(`预算用掉 ${usedPct}%，在预算内——安排得刚好`);
    } else {
      notes.push(
        `比预算少 ${formatCny(-diff)}（用掉 ${usedPct}%），预算宽松——可升级住宿或加一个体验`,
      );
    }
    if (largest) {
      notes.push(
        `${largest.label}占 ${largest.pct}%，是最大开销（人均 ${formatCny(largest.amount)}）`,
      );
    }
  }

  // 数据自洽性：行程上的总价与逐项合计对不上时，以逐项合计展示并明说。
  const declared = plan.totalCostCny;
  if (typeof declared === "number" && Number.isFinite(declared) && Math.round(declared) !== total) {
    notes.push(
      `行程记录的人均总花费 ${formatCny(declared)} 与逐项合计 ${formatCny(total)} 不一致，这里按逐项合计展示`,
    );
  }
  if (anomalyCount > 0) {
    notes.push(
      `有 ${anomalyCount} 个花费条目金额异常（负数/非数字），已按 0 计入——原始数据可能有误`,
    );
  }

  // 5) 每日花费（供未来复用：哪天最贵 / 预算按天分配）。
  const perDay: BudgetDay[] = days.map((day, i) => ({
    day: day.day,
    amount: dayAmounts[i],
    ...(budget !== undefined ? { pctOfBudget: Math.round((dayAmounts[i] / budget) * 100) } : {}),
  }));

  return {
    total,
    ...(budget !== undefined ? { budget } : {}),
    ...(usedPct !== undefined ? { usedPct } : {}),
    status,
    categories,
    ...(largest ? { largest } : {}),
    // 最多 3 条：notes[0] 是结论，其余是数据自洽性说明；极端数据问题也不刷屏
    notes: notes.slice(0, 3),
    perDay,
  };
}
