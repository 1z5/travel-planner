import "server-only";
import {
  haversineMeters,
  lookupPoi,
  routeSegment,
  searchPois,
  AMAP_MOCK,
  type PoiInfo,
} from "./amap";
import type { Plan, PlanInput, PlanSpot } from "./types";

// ============================================================
// 真实候选对比（产品线 S4 v0）：用户自己挑替代点，而不是只能让 AI「换一个」
//
// 为什么做：竞品调研里「AI 给的不能改/只能重抽」是头号差评；我们的「换一个」
// 每次都要赌一次模型。候选对比把选择权还给用户：给出 3 个**真实存在**的替代点
// （高德验真过的名称/评分/人均/营业时间 + 从上一站过去的真实通勤），用户点一个
// 就确定性替换——不调模型、不重抽。
//
// 三条红线（与全项目一致）：
// 1. **不猜**：候选必须 lookupPoi 命中才列；评分/人均/营业时间缺就缺，不填默认值；
//    通勤算不出就 null（不拿直线距离冒充通勤时间）。
// 2. **不装**：MOCK 模式（未接高德）直接返回 unavailable，不编候选清单。
// 3. **替换可追溯**：替换后整条行程要重跑体检（validatePlan），风险变化照实报。
// ============================================================

/** 候选与上一站的最大直线距离（米）：超过就不算「同一天顺路」的替代点 */
const MAX_CANDIDATE_METERS = 15_000;
/** 候选池上限：再多也是给用户看 3 个，多验只会浪费高德配额 */
const MAX_PICK = 6;
/** 最终展示的候选数 */
export const MAX_CANDIDATES = 3;

export interface SpotCandidate {
  name: string;
  area: string;
  rating?: number;
  avgCostCny?: number;
  openTime?: string;
  /** 与「当前这一站」的直线距离（米）；缺坐标时 null（不猜） */
  distanceFromPrevM: number | null;
  /** 从上一站过去的真实通勤分钟；算不出时 null */
  transitMin: number | null;
}

export type CandidatesResult =
  | { state: "ok"; candidates: SpotCandidate[]; prevName: string | null }
  | { state: "unavailable"; reason: string };

function keywordFor(spot: PlanSpot): string {
  // 只按类型取通用关键词：具体品类（川菜/博物馆）会让候选过窄；
  // 区域过滤交给「与当前站距离」这一步（不靠关键词猜地名）。
  return spot.type === "food" ? "美食" : "景点";
}

/** 找某一天某一站的真实替代候选 */
export async function findCandidates(
  plan: Plan,
  input: PlanInput,
  dayNo: number,
  spotIndex: number,
): Promise<CandidatesResult> {
  if (AMAP_MOCK) {
    return { state: "unavailable", reason: "未接入高德（MOCK 模式），没有真实候选可对比" };
  }
  const day = plan.days.find((d) => d.day === dayNo);
  const spot = day?.spots[spotIndex];
  if (!day || !spot) return { state: "unavailable", reason: "找不到这个行程点" };

  const search = await searchPois({
    city: input.city,
    keywords: keywordFor(spot),
    scope: input.scope ?? "city",
    limit: 20,
  });
  if (search.state === "error") {
    return { state: "unavailable", reason: `候选检索失败：${search.reason}` };
  }
  if (search.state === "miss") {
    return { state: "ok", candidates: [], prevName: day.spots[spotIndex - 1]?.name ?? null };
  }

  // 排除：已在行程里的点、当前点本身、重名候选
  const inPlan = new Set(plan.days.flatMap((d) => d.spots.map((s) => s.name)));
  const picked: PoiInfo[] = [];
  const seen = new Set<string>();
  for (const p of search.pois) {
    if (!p.name || !p.location) continue;
    if (inPlan.has(p.name) || seen.has(p.name)) continue;
    seen.add(p.name);
    picked.push(p);
    if (picked.length >= MAX_PICK) break;
  }

  const prevName = day.spots[spotIndex - 1]?.name ?? null;
  const prevLocation = day.spots[spotIndex - 1]?.location;
  const mode = input.transportMode ?? "driving";
  const candidates: SpotCandidate[] = [];

  for (const p of picked) {
    // 详情必须来自 lookupPoi（searchPois 的列表项不一定带营业时间/评分）
    const detail = await lookupPoi(input.city, p.name, input.scope ?? "city");
    if (detail.state !== "hit") continue; // 验不到就不列（不猜）
    const poi = detail.poi;
    const distanceFromPrevM = spot.location ? haversineMeters(spot.location, poi.location) : null;
    if (distanceFromPrevM !== null && distanceFromPrevM > MAX_CANDIDATE_METERS) continue;

    let transitMin: number | null = null;
    if (prevLocation) {
      const seg = await routeSegment(prevLocation, poi.location, mode);
      if (seg.state === "ok") transitMin = Math.max(1, Math.round(seg.leg.durationSec / 60));
    }

    candidates.push({
      name: poi.name,
      area: poi.adname,
      rating: poi.rating,
      avgCostCny: poi.avgCostCny,
      openTime: poi.openTime,
      distanceFromPrevM,
      transitMin,
    });
  }

  // 排序：通勤短的优先（算不出通勤的排后面，但不丢——用户仍可看评级选）
  candidates.sort((a, b) => (a.transitMin ?? 999) - (b.transitMin ?? 999));

  return { state: "ok", candidates: candidates.slice(0, MAX_CANDIDATES), prevName };
}

/**
 * 用候选替换某一站（纯函数，不调上游）：保留原站的时间/时段/停留/类型，
 * 名称/区域/坐标/POI 事实换成候选的。
 *
 * 为什么保留停留时长：候选的「建议游览时长」不是高德字段，编一个等于假装
 * 知道；保留原值并在 UI 里说明，用户可再改（后续「改时长」是独立能力）。
 * 为什么人均取高德 avgCostCny：它是**事实**（高德人均），比保留原值更准；
 * 缺数据时保留原值（不把预算算成 0）。
 */
export function buildReplacementSpot(oldSpot: PlanSpot, poi: PoiInfo): PlanSpot {
  return {
    ...oldSpot,
    name: poi.name,
    area: poi.adname || oldSpot.area,
    location: poi.location,
    costCny: poi.avgCostCny !== undefined ? poi.avgCostCny : oldSpot.costCny,
    poi: {
      ...(poi.rating !== undefined ? { rating: poi.rating } : {}),
      ...(poi.avgCostCny !== undefined ? { avgCostCny: poi.avgCostCny } : {}),
      ...(poi.openTime !== undefined ? { openTime: poi.openTime } : {}),
      ...(poi.openTime2 !== undefined ? { openTime2: poi.openTime2 } : {}),
      ...(poi.tel !== undefined ? { tel: poi.tel } : {}),
      ...(poi.temporarilyClosed !== undefined ? { temporarilyClosed: poi.temporarilyClosed } : {}),
    },
  };
}
