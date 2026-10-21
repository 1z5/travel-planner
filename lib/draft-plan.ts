import type { Plan, PlanDay, PlanSpot, PlanInput, Period, SpotType } from "./types";

// ============================================================
// 即时草稿：用户提交后 <100ms 生成结构化预览，LLM 完成后无缝替换。
//
// 为什么需要：step-5 生成完整行程要 3-5 分钟。这段时间用户面对空白
// 加载页，感觉像卡死了。即时草稿让用户在 <1s 内看到：
//   - 正确的城市/日期/预算/天数
//   - 每天的时段结构（早/午/晚）
//   - 时间轴骨架（几点到几点）
// 内容标记为「预览」，LLM 真实行程生成后整体替换。
//
// 诚实原则：草稿明确标记 draft=true，前端显示「快速预览」徽章，
// 不会让用户误以为这就是最终行程。
// ============================================================

/** 每天的标准时段模板（与 LLM 输出的 period 枚举一致） */
const DAY_TEMPLATE: Array<{
  period: Period;
  startHour: number;
  durationH: number;
  type: SpotType;
}> = [
  { period: "morning", startHour: 9, durationH: 2, type: "sight" },
  { period: "lunch", startHour: 12, durationH: 1, type: "food" },
  { period: "afternoon", startHour: 14, durationH: 2.5, type: "sight" },
  { period: "dinner", startHour: 18, durationH: 1.5, type: "food" },
  { period: "evening", startHour: 20, durationH: 1, type: "sight" },
];

/** 时段 → 中文标签 */
const PERIOD_LABEL: Record<Period, string> = {
  morning: "上午",
  lunch: "午餐",
  afternoon: "下午",
  dinner: "晚餐",
  evening: "晚间",
};

/** 类型 → 中文标签 */
const TYPE_LABEL: Record<SpotType, string> = {
  sight: "景点",
  food: "餐饮",
  hotel: "住宿",
  transport: "交通",
  shopping: "购物",
  activity: "体验",
};

function fmtTime(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * 生成即时草稿行程。
 *
 * 确定性：同样输入永远生成同样草稿（便于测试和缓存）。
 * 结构正确：天数、时段、时间轴都真实，只有 POI 名称是占位符。
 */
export function generateDraftPlan(input: PlanInput): Plan {
  const days: PlanDay[] = [];

  for (let d = 0; d < input.days; d++) {
    const spots: PlanSpot[] = [];
    let cursor = 9; // 每天 9:00 开始

    for (const slot of DAY_TEMPLATE) {
      // 最后一天晚餐后不加晚间（避免太晚）
      const isLastDay = d === input.days - 1;
      if (isLastDay && slot.period === "evening") continue;

      const start = Math.max(cursor, slot.startHour);
      const end = start + slot.durationH;

      spots.push({
        period: slot.period,
        time: `${fmtTime(start)}-${fmtTime(end)}`,
        type: slot.type,
        name: `${input.city}·${PERIOD_LABEL[slot.period]}${TYPE_LABEL[slot.type]}`,
        area: input.city,
        durationMin: Math.round(slot.durationH * 60),
        costCny: slot.type === "food" ? 80 : slot.type === "sight" ? 50 : 30,
        reason: "正在生成精确行程…",
      });

      cursor = end + 0.5; // 半小时间隔
    }

    days.push({
      day: d + 1,
      theme: `${input.city} 第 ${d + 1} 天`,
      spots,
      transitMin: 0,
      dailyCostCny: spots.reduce((s, x) => s + x.costCny, 0),
    });
  }

  return {
    city: input.city,
    startDate: input.startAt?.slice(0, 10),
    endDate: input.endAt?.slice(0, 10),
    startAt: input.startAt,
    endAt: input.endAt,
    summary: `${input.city} ${input.days} 天行程预览`,
    days,
    totalCostCny: days.reduce((s, d) => s + d.dailyCostCny, 0),
    budgetCny: input.budget,
    tips: [],
    warnings: [],
    verified: false,
    draft: true,
  };
}
