import "server-only";
import { AMAP_MOCK, lookupPoi, transitMinutes } from "./amap";
import { mapLimit } from "./concurrency";
import type { Plan, PlanDay, PlanInput } from "./types";

// 幻觉治理 + 行程体检。
// 定位：不改写 LLM 的行程（那是下一版的事），只做「标记 + 预警」——
// 用户看到的每个风险都摊开说，而不是假装完美。
//
// 三态原则（2026-10 健壮化）：
//   hit   → 景点/餐厅真实存在
//   miss  → 高德明确说没有 → 进 warnings（「未检索到」）
//   error → 网络抖动 / key 失效 / QPS 超限 → **不能**进 warnings。
//           把「服务不可用」说成「景点不存在」是预警系统在撒谎，
//           只会汇总成一条系统提示，并跳过依赖该数据的判定。
//
// 两条路径共用同一套体检逻辑：
//   validatePlan  单次调用路径（≤4 天）：逐天调 validateDay，最后统一收尾
//   validateDay   分日流式路径（≥5 天）：每生成一天就体检一天，
//                 预警随天数一起出现，不用等全量生成完

const TRANSIT_WARN_MIN = 120;   // 当天通勤超过 2 小时视为疑似绕路
const LOOSE_DAY_MIN = 5 * 60;   // 每天净时长低于 5h 视为过松
// 节奏上限按用户选择的行程分档（默认适中 10h）——避免"天天偏满"的告警噪音
const PACE_DAY_MIN: Record<NonNullable<PlanInput["pace"]>, number> = {
  relaxed: 8 * 60,
  balanced: 10 * 60,
  packed: 13 * 60,
};
const PACE_LABEL: Record<NonNullable<PlanInput["pace"]>, string> = {
  relaxed: "轻松",
  balanced: "适中",
  packed: "紧凑",
};
const BUDGET_OVER = 1.05;       // 总花费超预算 5% 预警
// 总花费低于预算 80% 给提示——阈值与 prompt 的「至少用掉 80%」契约严格对齐：
// 模型没兑现自己承诺的规则时，用户应该得到信号（以前只查上限，是 asymmetric 的）
const BUDGET_UNDER = 0.8;
// 区域分散度预警：当天的景点（sight）跨过这么多不同区县就提示。
// 阈值用真实数据校准过（京都 5 天实测归一到区县后是 1/1/1/2/3，全部正常），
// 取 4 是宁可漏报不要误报——预警变成噪声比没有预警更糟。
const AREA_SPREAD_WARN = 4;
// POI 验真/通勤估算的并发上限：个人高德 key 有 QPS 限制，5 路是速度与配额的安全档
const VERIFY_CONCURRENCY = 5;

/**
 * 把 area 归一到「区县」粒度：「北区金阁寺」→「北区」。
 *
 * 为什么必须归一：area 字段粒度极细，同一片区会有多个字符串（「祇园」
 * 「先斗町」「祇园至鸭川先斗町」实为同一带）。按原始字符串数会把正常
 * 行程误报成一团散沙——实测某天全量 10 个区域，但景点只占 3 个且同属
 * 东山区。无区县前缀的（如「春熙路」「东福寺一带」）原样返回，不与别处合并。
 */
export function areaRegion(area: string): string {
  const m = String(area).match(/^(.{1,3}?(?:区|县|市|镇|乡))/);
  return m ? m[1] : String(area);
}

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

/** 单日体检结果 */
export interface DayCheck {
  warnings: string[];       // 当天的预警（POI 未命中 / 通勤 / 节奏）
  unverified: string[];     // 因上游异常未能验真的 POI（≠不存在）
  transitUnknown: boolean;  // 当天通勤是否无法估算
}

/**
 * 体检单独一天：POI 验真 + 通勤估算 + 节奏判定，
 * 并回填该天的 transitMin / transitKnown / dailyCostCny。
 *
 * 注意：不改 plan 级字段（totalCostCny / warnings / verified），
 * 那些由调用方在收尾时统一处理——分日路径要逐天累积，不能每次覆盖。
 */
export async function validateDay(plan: Plan, day: PlanDay, input: PlanInput): Promise<DayCheck> {
  const warnings: string[] = [];
  const unverified: string[] = [];
  let transitUnknown = false;

  // 1) POI 验真：景点和餐厅必须真实存在。
  //    有界并发 + 保序：warning 仍按当天顺序输出。
  if (!AMAP_MOCK) {
    const targets = day.spots
      .filter((s) => s.type === "sight" || s.type === "food")
      .map((s) => ({ name: s.name, day: day.day }));
    const results = await mapLimit(targets, VERIFY_CONCURRENCY, async (t) => ({
      t,
      r: await lookupPoi(plan.city, t.name),
    }));
    for (const { t, r } of results) {
      if (r.state === "miss") {
        warnings.push(
          `第 ${t.day} 天「${t.name}」未在高德检索到，可能名称有误或已关闭，出发前请自行确认`,
        );
      } else if (r.state === "error") {
        unverified.push(t.name);
      }
    }
  }

  // 2) 通勤：相邻站点间估算，有界并发（段与段互不依赖）。
  //    MOCK 模式下不估算——哈希假数据只会制造「疑似绕路」的虚假预警，
  //    节奏判定也退化为纯停留时长（avoids 假数据污染两个指标）。
  let transit = 0;
  if (!AMAP_MOCK) {
    const segments: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < day.spots.length - 1; i++) {
      segments.push({ from: day.spots[i].name, to: day.spots[i + 1].name });
    }
    const segResults = await mapLimit(segments, VERIFY_CONCURRENCY, async (seg) => ({
      seg,
      r: await transitMinutes(plan.city, seg.from, seg.to),
    }));
    for (const { r } of segResults) {
      if (r.state === "unknown") transitUnknown = true;
      else transit += r.minutes;
    }
    if (!transitUnknown && transit > TRANSIT_WARN_MIN) {
      warnings.push(
        `第 ${day.day} 天站点间通勤约 ${fmtMin(transit)}，偏长，可能存在绕路，建议合并同区域景点`,
      );
    }
  }
  day.transitMin = transit;
  day.transitKnown = !transitUnknown;

  // 3) 节奏：停留 + 通勤。
  //    通勤未知时跳过——只算停留会把「偏松」误报给用户。
  const active = day.spots.reduce((s, x) => s + x.durationMin, 0) + transit;
  const pace = input.pace ?? "balanced";
  if (!transitUnknown) {
    if (active > PACE_DAY_MIN[pace]) {
      warnings.push(
        `第 ${day.day} 天安排约 ${fmtMin(active)}，超出${PACE_LABEL[pace]}节奏上限（${PACE_DAY_MIN[pace] / 60} 小时），可删减 1 个景点或改选更紧凑节奏`,
      );
    } else if (active < LOOSE_DAY_MIN) {
      warnings.push(`第 ${day.day} 天安排约 ${fmtMin(active)}，偏松，可加一个景点或放慢节奏`);
    }
  }

  // 4) 区域分散度：当天的景点跨过太多不同区县 → 绕路的直接前兆。
  //    prompt 里「同一天的景点集中在同一 area」是明确规则，这里核验它。
  //
  //    只在拿不到通勤信号时才报（AMAP_MOCK 或该天通勤估算失败）：
  //    接了高德 key 时，通勤预警是更直接的绕路证据，两者同时报是噪声。
  //    这也正是 MOCK 模式下唯一的绕路信号——没配 key 时通勤完全不估算。
  if (AMAP_MOCK || transitUnknown) {
    const sights = day.spots.filter((s) => s.type === "sight");
    const regions = new Set(sights.map((s) => areaRegion(s.area)));
    if (regions.size >= AREA_SPREAD_WARN) {
      warnings.push(
        `第 ${day.day} 天的 ${sights.length} 个景点分散在 ${regions.size} 个不同区域（${[...regions].join("、")}），通勤与折返可能明显增加，建议合并同区域景点或拆分到多天`,
      );
    }
  }

  // 5) 当天人均花费
  day.dailyCostCny = day.spots.reduce((s, x) => s + x.costCny, 0);

  return { warnings, unverified, transitUnknown };
}

/** plan 级收尾所需的上下文（由调用方逐天累积而来） */
export interface FinalizeCtx {
  warnings: string[];
  unverified: string[];
  transitUnknownDays: number[];
  grandTotal: number;
}

/**
 * plan 级收尾：预算核对 + 用户硬约束核验 + 验真完成度 + 系统提示。
 * 分日路径在所有天生成完后调用一次；单次路径在 validatePlan 末尾调用。
 */
export function finalizePlan(plan: Plan, input: PlanInput, ctx: FinalizeCtx): void {
  const { warnings, unverified, transitUnknownDays, grandTotal } = ctx;

  if (grandTotal > input.budget * BUDGET_OVER) {
    warnings.push(
      `行程合计人均约 ${grandTotal} 元，超出预算 ${input.budget} 元 ${Math.round((grandTotal / input.budget - 1) * 100)}%，注意控制`,
    );
  } else if (grandTotal < input.budget * BUDGET_UNDER) {
    // 与超预算对称的提示。定位是「信息性」而非风险——钱没花完不是坏事，
    // 但意味着可能漏掉了预算本可覆盖的体验（住得更好/多一个项目），
    // 或者用户的预算估值本身偏高。给可行动的建议，不做价值判断。
    warnings.push(
      `预算较为宽松：合计人均约 ${grandTotal} 元，用掉预算 ${input.budget} 元的 ${Math.round((grandTotal / input.budget) * 100)}%。可提高住宿档次或增加体验项目，也可以调低预算让规划更聚焦`,
    );
  }

  // 用户硬约束核验：prompt 要求了，这里验证承诺是否兑现
  const allSpotNames = plan.days.flatMap((d) => d.spots.map((s) => s.name)).join("\n");
  for (const mv of input.mustVisit ?? []) {
    if (!allSpotNames.includes(mv)) {
      warnings.push(
        `必游地「${mv}」未出现在行程中——可重试，或检查名称是否与当地叫法一致`,
      );
    }
  }
  const hotel = input.hotel?.trim();
  if (hotel) {
    // 用户可能给模糊描述（"住春熙路附近"），模型会合理转化成具体酒店
    // （"春熙路亚朵S酒店"）——全字符串匹配会误报。提取场所核心词双路匹配：
    // 完整串命中（用户给了确切酒店名）或核心词命中（模糊描述的正确执行）
    const hotelKey = hotel
      .replace(/住在?|附近|旁边|一带|周边|那一片|这边/g, "")
      .replace(/的?(酒店|宾馆|民宿|旅馆)/g, "")
      .trim() || hotel;
    const mentioned = plan.days.some((d) =>
      d.spots.some((s) =>
        s.name.includes(hotel) || s.area.includes(hotel)
        || (hotelKey.length >= 2 && (s.name.includes(hotelKey) || s.area.includes(hotelKey)))));
    if (!mentioned) {
      warnings.push(`住所「${hotel}」未体现在行程中——行程应以它为每日出发点`);
    }
  }

  plan.totalCostCny = grandTotal;
  plan.warnings = warnings;
  plan.verified = !AMAP_MOCK;
  plan.verification = AMAP_MOCK ? "mock" : unverified.length ? "partial" : "ok";

  // 系统提示放在最后：与行程风险区分开，且不冒充「景点不存在」
  if (unverified.length) {
    const sample = unverified.slice(0, 3).join("、");
    warnings.push(
      `高德服务波动：${unverified.length} 个地点（${sample}${unverified.length > 3 ? " 等" : ""}）本次未能验真，POI 核查不完整——请稍后重试或手动确认`,
    );
  }
  if (transitUnknownDays.length) {
    warnings.push(
      `第 ${transitUnknownDays.join("、")} 天通勤估算失败（高德服务波动），当天的通勤与节奏体检已跳过，未按估算值判定`,
    );
  }
}

/** 单次调用路径（≤4 天）：逐天体检 + 统一收尾 */
export async function validatePlan(plan: Plan, input: PlanInput): Promise<Plan> {
  const warnings: string[] = [];
  const unverified: string[] = [];
  const transitUnknownDays: number[] = [];
  let grandTotal = 0;

  for (const day of plan.days) {
    const check = await validateDay(plan, day, input);
    warnings.push(...check.warnings);
    unverified.push(...check.unverified);
    if (check.transitUnknown) transitUnknownDays.push(day.day);
    grandTotal += day.dailyCostCny;
  }

  finalizePlan(plan, input, { warnings, unverified, transitUnknownDays, grandTotal });
  return plan;
}
