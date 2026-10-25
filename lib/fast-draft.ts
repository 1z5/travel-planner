import type { Plan, PlanDay, PlanSpot, PlanInput, Period, SpotType } from "./types";
import type { Grounding } from "./grounding";

// ============================================================
// 秒级初版（Fast Draft）： grounding 就绪后（约 2 秒）用**真实 POI 名单**
// 组装一版可读行程，LLM 精排版（3-5 分钟）到达后整体替换。
//
// 为什么做：用户拿我们和豆包比——豆包几秒出稿，我们 3 分钟黑盒。核验是
// 核心价值，但不能让用户干等。草稿机制原来只有 <100ms 的结构骨架（POI 名
// 是「成都·上午景点」占位符），用户仍然看不到任何真实内容。
//
// 诚实原则（不可违反）：
// - POI 名称、区域、评分来自高德真实检索结果（**存在性已核实**）；
// - 但**动线与时间未精排**（通勤未算、营业时间未逐条核、预算未精算），
//   所以初版明确标注 draftKind="fast"，UI 显示「快速初版」徽章与说明；
// - 没有 grounding（未接高德/检索失败）时**不发布初版**——宁可让用户看
//   骨架，也不拿编造的 POI 名冒充真实地点。
// ============================================================

/** 每天的时段模板：与 LLM 输出的 period 枚举一致，顺序即当天动线 */
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

/** 跨城段的城际交通 spot（用户提供了班次活动时才会被填具体时间） */
function intercitySpot(from: string, to: string, hour: number): PlanSpot {
  return {
    period: "afternoon",
    time: `${fmt(hour)}-${fmt(hour + 1.5)}`,
    type: "transport",
    name: `${from} → ${to}`,
    area: from,
    durationMin: 90,
    costCny: 0,
    reason: "跨城交通段：具体班次时间以你添加的重点活动为准，这里先占位。",
  };
}

function fmt(hour: number): string {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** 当天所属城市（跨城按天分配；与 planner.dayCityOf 同口径但 client-safe） */
function cityOfDay(input: PlanInput, day: number): string {
  const cities = input.cities;
  if (!cities?.length) return input.city;
  let acc = 0;
  for (const c of cities) {
    acc += c.days;
    if (day <= acc) return c.city;
  }
  return cities[cities.length - 1].city;
}

/**
 * 组装秒级初版。确定性：同样输入 + 同样候选名单 → 同样输出（可测试、可复现）。
 *
 * 预算口径：按天均摊（budget/days），当天贪心选取到接近但不超出；预算 0
 * （穷游）时只选免费/低价候选，不设上限。
 */
export function buildFastDraft(input: PlanInput, grounding: Grounding): Plan {
  const cities = input.cities?.length ? input.cities : undefined;
  // 候选按「信息完整度」排序已在 grounding 内完成，这里按 kind 分流后按序取用
  const sights = grounding.candidates.filter((c) => c.kind === "sight");
  const foods = grounding.candidates.filter((c) => c.kind === "food");
  const used = new Set<string>();
  const perDayBudget = input.budget > 0 ? input.budget / input.days : 0;

  const take = (pool: typeof sights, maxCost: number): (typeof sights)[number] | undefined => {
    for (const c of pool) {
      if (used.has(c.name)) continue;
      const cost = c.avgCostCny ?? (c.kind === "food" ? 60 : 40);
      // 穷游模式（perDayBudget=0）：只取免费/低价（<=60 元）
      if (perDayBudget === 0 ? cost <= 60 : cost <= maxCost) {
        used.add(c.name);
        return c;
      }
    }
    return undefined;
  };

  /**
   * 当天的主活动区域：未使用候选最多的 area。
   *
   * 为什么需要：候选按「信息完整度」排序，分数高的可能在郊县（安仁古镇评分高
   * 但在大邑县）。初版若照分数取，一天里会出现「郊县古镇 + 市中心公园 + 太古里」
   * 这种必然绕路的组合——初版可以不算通勤，但不该一开始就选错地理。
   * 同区聚合本来就是产品原则（PlanSpot.area 的注释：同区聚合减少绕路）。
   */
  const primaryArea = (() => {
    const byArea = new Map<string, number>();
    for (const c of [...sights, ...foods]) {
      if (used.has(c.name)) continue;
      const a = c.area?.trim();
      if (!a) continue;
      byArea.set(a, (byArea.get(a) ?? 0) + 1);
    }
    let best: string | undefined;
    let bestN = 0;
    for (const [a, n] of byArea) {
      if (n > bestN) {
        best = a;
        bestN = n;
      }
    }
    return best;
  })();

  /** 选点优先同区；同区取不到再全局取（宁可比理想路线远一点，不留空时段） */
  const pickFrom = (pool: typeof sights, maxCost: number) =>
    (primaryArea
      ? take(
          pool.filter((c) => c.area?.trim() === primaryArea),
          maxCost,
        )
      : undefined) ?? take(pool, maxCost);

  const days: PlanDay[] = [];
  let sightIdx = 0;
  let foodIdx = 0;
  // 每天的取点上限：候选池按天均摊，避免第一天把池子拿光、后面几天全空。
  // （实测踩过：4 个候选 + 6 天行程，全塞给第一天，后面五天只剩空骨架。）
  // 池子比天数还小时上限仍然生效——拿不到就留空，不编造占位点。
  const perDayCap = Math.max(2, Math.ceil(grounding.candidates.length / input.days));

  for (let d = 0; d < input.days; d++) {
    const dayNo = d + 1;
    const dayCity = cityOfDay(input, dayNo);
    const prevCity = d > 0 ? cityOfDay(input, d) : undefined;
    const spots: PlanSpot[] = [];
    let cursor = 9;
    let spent = 0;

    // 跨城日：上午收尾上一城由精排版负责，这里先放一段城际交通占位
    if (cities && prevCity && prevCity !== dayCity) {
      const leg = intercitySpot(prevCity, dayCity, 14);
      spots.push(leg);
      cursor = 15.5;
    }

    let picked = 0; // 当天已取的真实 POI 数（跨城交通段/住所不计入上限）
    for (const slot of DAY_TEMPLATE) {
      if (picked >= perDayCap) break; // 留给后面的天
      const isLastDay = d === input.days - 1;
      if (isLastDay && slot.period === "evening") continue;
      // 跨城日只排抵达后的轻松点位（下午一个景点 + 晚餐）
      if (cities && prevCity && prevCity !== dayCity) {
        if (slot.period === "morning" || slot.period === "lunch" || slot.period === "afternoon")
          continue;
      }

      const start = Math.max(cursor, slot.startHour);
      const end = start + slot.durationH;
      const remain = perDayBudget > 0 ? Math.max(0, perDayBudget - spent) : 0;

      if (slot.type === "sight") {
        const pool = sights.filter((c) => !used.has(c.name));
        const pick = pickFrom(pool, perDayBudget > 0 ? Math.max(60, remain) : 60);
        if (pick) {
          sightIdx += 1;
          picked += 1;
          spent += pick.avgCostCny ?? 40;
          spots.push({
            period: slot.period,
            time: `${fmt(start)}-${fmt(end)}`,
            type: "sight",
            name: pick.name,
            area: pick.area || dayCity,
            durationMin: Math.round(slot.durationH * 60),
            costCny: pick.avgCostCny ?? 40,
            reason: `高德候选（${pick.rating ? `评分 ${pick.rating.toFixed(1)}` : "已核实存在"}），动线与时间待精排。`,
            location: pick.location,
          });
          cursor = end + 0.5;
          continue;
        }
      } else if (slot.type === "food") {
        const pool = foods.filter((c) => !used.has(c.name));
        const pick = pickFrom(pool, perDayBudget > 0 ? Math.max(60, remain) : 60);
        if (pick) {
          foodIdx += 1;
          picked += 1;
          spent += pick.avgCostCny ?? 60;
          spots.push({
            period: slot.period,
            time: `${fmt(start)}-${fmt(end)}`,
            type: "food",
            name: pick.name,
            area: pick.area || dayCity,
            durationMin: Math.round(slot.durationH * 60),
            costCny: pick.avgCostCny ?? 60,
            reason: `高德候选（${pick.rating ? `评分 ${pick.rating.toFixed(1)}` : "已核实存在"}），动线与时间待精排。`,
            location: pick.location,
          });
          cursor = end + 0.5;
          continue;
        }
      }

      // 候选取完（或都超预算）时不编造占位点：留空该时段。
      // 诚实原则：宁可少一个点，也不生成「成都·上午景点」这种假名字。
      cursor = end + 0.5;
    }

    // 住宿：多天行程第一天用用户住所（与 LLM 路径同口径）
    if (dayNo === 1 && input.days > 1 && input.hotel?.trim()) {
      spots.push({
        period: "evening",
        time: "21:00-22:00",
        type: "hotel",
        name: input.hotel.trim(),
        area: dayCity,
        durationMin: 60,
        costCny: 0,
        reason: "你指定的住所（房价未计入，精排版会补）。",
      });
    }

    if (!spots.length) continue;
    days.push({
      day: dayNo,
      city: cities ? dayCity : undefined,
      theme: `${dayCity} 第 ${dayNo} 天`,
      spots,
      transitMin: 0,
      dailyCostCny: spots.reduce((s, x) => s + x.costCny, 0),
    });
  }

  const totalCost = days.reduce((s, d) => s + d.dailyCostCny, 0);
  return {
    city: cities ? cities[0].city : input.city,
    ...(cities ? { cities } : {}),
    startDate: input.startAt?.slice(0, 10),
    endDate: input.endAt?.slice(0, 10),
    startAt: input.startAt,
    endAt: input.endAt,
    summary: `${input.city} ${input.days} 天行程 · 快速初版`,
    days,
    totalCostCny: totalCost,
    budgetCny: input.budget,
    tips: [],
    warnings: [],
    verified: false,
    draft: true,
    draftKind: "fast",
  };
}

/** 初版是否值得发布：至少有 1 天、每天至少 1 个真实 POI */
export function isPublishableFastDraft(plan: Plan): boolean {
  return plan.days.length > 0 && plan.days.every((d) => d.spots.some((s) => s.location));
}
