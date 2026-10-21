import "server-only";
import { searchPois, type PoiInfo, type PoiSearchResult } from "./amap";
import { mapLimit } from "./concurrency";
import { checkDayAvailability, formatHoursShort } from "./poi-hours";
import type { PlanGrounding, PlanInput } from "./types";

// ============================================================
// 事实先行（Grounded Planning）：把真实世界喂给模型，再让它排行程。
//
// 【为什么这是架构级的改动】
// 原来的链路是「先编后验」：
//   LLM 盲写 POI 名 → 高德逐个验真 → 体检抓闭馆日/绕路/时间接不上 → 用户一键修
// 也就是说，产品最值钱的能力（真实世界事实）**全部用在了生成之后**。
// 模型写「苏州博物馆」时，它并不知道苏州博物馆周一闭馆，也不知道自己排的
// 两站之间要走 22 分钟——所以它必然编错、必然排到闭馆日、必然绕路，
// 而这些都要等体检来兜。体检是安全网，不该是生产线。
//
// 现在改成「先验后编」：
//   高德候选检索 → 事实清单（真实存在 + 营业时间 + 闭馆日 + 评分 + 人均）
//                → 注入 prompt → 模型在真实事实上排行程 → 体检退化为兜底
// 结果不是「少几条预警」，而是**行程天生可执行**：闭馆日在源头就被排除，
// POI 全部来自真实检索（验真命中率天然更高），而且模型不必再靠记忆编造
// 名称与营业时间——事实已经摆在它面前了，reasoning 更短、生成更快。
//
// 【诚实红线】
// - 事实层拿不到（无 key / 上游异常 / 境外无覆盖）→ 不生成清单，退回原链路，
//   **绝不编造候选**。清单是锦上添花，不是新的单点故障。
// - 营业时间读不懂 → unknown → 该地点照常进入清单但不标时间（宁可少说，
//   不能说错）。闭馆与否只在「确信闭馆」时才判定。
// - 闭馆只对**确信**的日子生效：周一闭馆的博物馆在周二照常可用，
//   不能因为「有一天闭馆」就把整趟旅行的候选全删掉。
// ============================================================

/** 清单里的地点类型（只分两类：景点 / 餐饮——行程点的主体） */
export type GroundingKind = "sight" | "food";

/** 一条事实：真实存在、且带着高德核验过的事实字段 */
export interface GroundingCandidate {
  name: string;
  kind: GroundingKind;
  area: string;
  location: string;
  rating?: number;
  avgCostCny?: number;
  /** 行程日当天的营业时段（如 "09:00-17:30"）；拿不到就不填 */
  hours?: string;
  /** 行程期内闭馆的日期（如 "10-21（周一）"）；没有就不填 */
  closedOn?: string;
  /** 闭馆原因（如 "周一闭馆"），用于让模型知道该换哪天 */
  closedReason?: string;
}

export interface Grounding {
  /** ok=有可用清单；empty=检索到了但没有可用候选；unavailable=拿不到事实层 */
  state: "ok" | "empty" | "unavailable";
  /** 可供选择的候选（已剔除全程闭馆/暂停开放的） */
  candidates: GroundingCandidate[];
  /** 行程期内**全程**闭馆、已从候选中剔除的地点（要让模型知道别排它） */
  closedOut: GroundingCandidate[];
  /** 实际发出的检索词（可追溯：清单是从哪查出来的） */
  queries: string[];
  /** 降级说明（如"高德未覆盖该目的地"） */
  note?: string;
}

/** 检索器签名：可注入，便于单测不依赖网络 */
export type PoiSearcher = (opts: {
  city: string;
  keywords: string;
  scope: "city" | "region";
  limit: number;
}) => Promise<PoiSearchResult>;

// ---------- 检索词 ----------

/**
 * 城市级品类检索词。
 *
 * 为什么是这几个：高德 place/text 的 keywords 会匹配 POI 的名称、地址与
 * **分类名**，所以词必须落在高德真实的分类名里（"博物馆"、"公园"、"古镇"、
 * "餐厅" 都是高德分类名；"景点" 不是——它只作为兜底词存在，命中与否由
 * 高德说了算，miss 不算失败）。
 * 购物/住宿/交通不查：购物与住宿模型自己会安排（且多半是用户指定的），
 * 塞进清单只会挤占模型的注意力。
 */
const CITY_SIGHT_QUERIES = ["景点", "博物馆", "古镇", "公园"];
const CITY_FOOD_QUERIES = ["餐厅"];

/** 单次检索最多取多少条 */
const QUERY_LIMIT = 8;
/** 清单体积随天数增长：4 天以内 12 景点 + 8 餐饮；7 天要能装下 21 个景点 */
const MAX_SIGHT_BASE = 12;
const MAX_FOOD_BASE = 8;
const MAX_SIGHT_CAP = 30;
const MAX_FOOD_CAP = 20;
/** 检索并发：个人 key 的 QPS 很低，串行为主，留一点并发给多天场景 */
const SEARCH_CONCURRENCY = 2;

/**
 * 清单容量按天数算。
 *
 * 为什么必须随天数涨：7 天 × 每天 3 个景点 = 21 个景点位。若清单只给 12 个，
 * 模型要么重复安排，要么频繁跳出清单（跳出就没有事实兜底了）——事实先行的
 * 收益会被"清单不够用"抵消掉。
 */
function capsFor(days: number): { maxSight: number; maxFood: number } {
  const extra = Math.max(0, days - 4);
  return {
    maxSight: Math.min(MAX_SIGHT_CAP, MAX_SIGHT_BASE + extra * 3),
    maxFood: Math.min(MAX_FOOD_CAP, MAX_FOOD_BASE + extra * 2),
  };
}

// ---------- 分类 ----------

/**
 * 用高德自己的 type 字段归类，不靠名字猜。
 *
 * 只认「风景名胜/公园/博物馆/展览…」与「餐饮服务/餐厅/…」两大类；
 * 认不出的（购物、住宿、交通、医疗、公司、门址…）直接丢弃——它们不是
 * 行程点的主体，塞进清单只会稀释模型注意力。
 */
export function classifyPoi(poiType: string | undefined): GroundingKind | null {
  if (!poiType) return null;
  if (/餐饮服务|餐厅|小吃|美食|咖啡|茶馆|火锅|烧烤|酒吧|面馆/.test(poiType)) return "food";
  if (/风景名胜|公园|博物馆|展览|纪念馆|美术馆|遗址|古镇|名胜|景区|观光|游览/.test(poiType)) {
    return "sight";
  }
  return null;
}

// ---------- 日期 ----------

/** 行程日期（本地日历日 "YYYY-MM-DD"）；没有起止时间就返回空 */
export function tripDates(input: PlanInput): string[] {
  const start = input.startAt?.slice(0, 10);
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return [];
  const base = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(base)) return [];
  const days = Math.max(1, Math.min(30, input.days || 1));
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const WEEK_LABEL = ["日", "一", "二", "三", "四", "五", "六"];

function dateLabel(iso: string): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  const wd = new Date(t).getUTCDay();
  return `${iso.slice(5)}（周${WEEK_LABEL[wd]}）`;
}

// ---------- 候选加工 ----------

/** 事实完整度：用于同一个 POI 在多个检索词下重复出现时，保留信息更全的那条 */
function infoScore(c: GroundingCandidate): number {
  let n = 0;
  if (c.rating !== undefined) n++;
  if (c.avgCostCny !== undefined) n++;
  if (c.hours) n++;
  if (c.area) n++;
  if (c.location) n++;
  return n;
}

/** 去重键：同名 + 同位置算同一个 POI（高德同名不同址的也很常见，用位置兜一层） */
function dedupeKey(c: GroundingCandidate): string {
  return `${c.name.trim()}@${c.location}`;
}

/**
 * 把一条高德 POI 加工成事实条目：补上行程日当天的营业时段 / 闭馆日。
 *
 * 闭馆判定用 checkDayAvailability（当天可用性），逐个行程日地问：
 * - 全程 closed → 该地点整趟不可用 → 进 closedOut（模型别排它）
 * - 某几天 closed → 保留在候选里，但标出「这几天闭馆」，模型可换到别的日子
 * - unknown → 不标任何时间（宁可少说，不能说错）
 */
function toCandidate(
  poi: PoiInfo,
  kind: GroundingKind,
  dates: string[],
): { candidate: GroundingCandidate; closedAll: boolean } {
  const candidate: GroundingCandidate = {
    name: poi.name,
    kind,
    area: poi.adname || "",
    location: poi.location,
  };
  if (poi.rating !== undefined) candidate.rating = poi.rating;
  if (poi.avgCostCny !== undefined) candidate.avgCostCny = poi.avgCostCny;

  // 人话营业时间优先（它含闭馆日，且对季节性规则宁可不给也不给错）
  const short = formatHoursShort(poi);
  if (short) candidate.hours = short;

  const closedDates: string[] = [];
  let closedReason: string | undefined;
  let openWindows: string | undefined;
  for (const date of dates) {
    const day = checkDayAvailability(poi, date);
    if (day.state === "closed") {
      closedDates.push(date);
      closedReason = closedReason ?? day.reason;
    } else if (day.state === "open" && !openWindows) {
      openWindows = day.windows;
    }
  }

  if (closedDates.length === dates.length && dates.length > 0) {
    // 全程闭馆
    candidate.closedOn = closedDates.map(dateLabel).join("、");
    candidate.closedReason = closedReason;
    return { candidate, closedAll: true };
  }
  if (closedDates.length) {
    candidate.closedOn = closedDates.map(dateLabel).join("、");
    candidate.closedReason = closedReason;
  }
  // 没有可读的人话摘要时，用行程首日的实际营业时段兜底
  if (!candidate.hours && openWindows) candidate.hours = openWindows;

  return { candidate, closedAll: false };
}

// ---------- 收集 ----------

export interface CollectGroundingOptions {
  /** 注入检索器（单测用；默认走高德） */
  search?: PoiSearcher;
  /** 追加检索词（如某一天的主题/区域） */
  extraKeywords?: string[];
  /** 已有的候选（多天流式：城市级清单 + 每天的主题清单） */
  seed?: GroundingCandidate[];
}

/**
 * 收集事实清单。**永不抛错**：任何失败都降级成 state="unavailable"，
 * 让生成链路照常走（这是新增能力，必须是无单点故障的增强）。
 */
export async function collectGrounding(
  input: PlanInput,
  opts: CollectGroundingOptions = {},
): Promise<Grounding> {
  const search = opts.search ?? searchPois;
  const scope: "city" | "region" = input.scope ?? "city";
  const dates = tripDates(input);

  // 检索词：城市级品类词 + 追加词（主题/区域）。去重后限量。
  const keywords: string[] = [];
  const push = (kw: string) => {
    const k = kw.trim();
    if (!k) return;
    if (!keywords.includes(k)) keywords.push(k);
  };
  for (const q of CITY_SIGHT_QUERIES) push(`${input.city} ${q}`);
  for (const q of CITY_FOOD_QUERIES) push(`${input.city} ${q}`);
  for (const q of opts.extraKeywords ?? []) push(q);
  const capped = keywords.slice(0, 12);

  const results = await mapLimit(capped, SEARCH_CONCURRENCY, async (keywordsText) => {
    try {
      const r = await search({
        city: input.city,
        keywords: keywordsText,
        scope,
        limit: QUERY_LIMIT,
      });
      return { keywordsText, r };
    } catch {
      // 单个检索词失败不影响整体（上游波动不该拖垮事实层）
      return { keywordsText, r: { state: "error", reason: "检索异常" } as PoiSearchResult };
    }
  });

  const byKey = new Map<string, GroundingCandidate>();
  const closedByKey = new Map<string, GroundingCandidate>();
  let hits = 0;
  let errors = 0;

  for (const { r } of results) {
    if (r.state === "error") {
      errors++;
      continue;
    }
    if (r.state === "miss") continue;
    hits++;
    for (const poi of r.pois) {
      const kind = classifyPoi(poi.poiType);
      if (!kind) continue;
      if (!poi.name || !poi.location) continue;
      const { candidate, closedAll } = toCandidate(poi, kind, dates);
      const key = dedupeKey(candidate);
      const prev = byKey.get(key) ?? closedByKey.get(key);
      if (prev && infoScore(prev) >= infoScore(candidate)) continue;
      if (closedAll) {
        byKey.delete(key);
        closedByKey.set(key, candidate);
      } else {
        closedByKey.delete(key);
        byKey.set(key, candidate);
      }
    }
  }

  // 合并外部传入的种子（多天流式：城市级清单 + 当天主题清单）
  for (const c of opts.seed ?? []) {
    const key = dedupeKey(c);
    const prev = byKey.get(key);
    if (!prev || infoScore(prev) < infoScore(c)) byKey.set(key, c);
  }

  const all = [...byKey.values()];
  const sights = all.filter((c) => c.kind === "sight");
  const foods = all.filter((c) => c.kind === "food");

  // 排序：事实越完整越靠前（模型先看到最有用的），其次评分
  const rank = (a: GroundingCandidate, b: GroundingCandidate) => {
    const s = infoScore(b) - infoScore(a);
    if (s !== 0) return s;
    return (b.rating ?? 0) - (a.rating ?? 0);
  };
  sights.sort(rank);
  foods.sort(rank);

  const { maxSight, maxFood } = capsFor(input.days || 1);
  const candidates = [...sights.slice(0, maxSight), ...foods.slice(0, maxFood)];
  const closedOut = [...closedByKey.values()].slice(0, 6);

  if (hits === 0) {
    // 一个检索词都没命中：区分「没覆盖」与「上游异常」，两者都不生成清单
    return {
      state: "unavailable",
      candidates: [],
      closedOut: [],
      queries: capped,
      note:
        errors > 0
          ? "高德检索异常，本次未使用事实清单（行程照常生成，体检仍会兜底）"
          : `高德未覆盖「${input.city}」，本次未使用事实清单（行程照常生成，体检仍会兜底）`,
    };
  }
  if (!candidates.length) {
    // 注意：这里必须**保留 closedOut**——「这些地方别排」比「清单为空」更有用，
    // 丢掉它就等于把刚查到的闭馆事实扔了（踩过：early return 把闭馆清单抹平）。
    return {
      state: "empty",
      candidates: [],
      closedOut,
      queries: capped,
      note: closedOut.length
        ? `检索到的地点在行程日期内均闭馆，已列出禁排清单`
        : "高德检索到的地点都不属于景点/餐饮，未使用事实清单",
    };
  }
  return { state: "ok", candidates, closedOut, queries: capped };
}

/**
 * 事实清单的摘要（写进 Plan.grounding，给 UI 如实展示）。
 * 没有清单时返回 undefined——UI 必须能区分「没用事实层」与「用了但很少」。
 */
export function groundingSummary(g: Grounding | undefined): PlanGrounding | undefined {
  return groundingSummaryOf([g]);
}

/**
 * 多份清单的并集摘要（多天流式：城市级清单 + 每天的主题清单）。
 * 按「名称+坐标」去重，所以同一个地点不会重复计数。
 */
export function groundingSummaryOf(
  groundings: ReadonlyArray<Grounding | undefined>,
): PlanGrounding | undefined {
  const seen = new Map<string, GroundingCandidate>();
  const closedSeen = new Set<string>();
  for (const g of groundings) {
    if (!g || g.state === "unavailable") continue;
    // 候选只在 ok 状态有意义；闭馆禁排清单在 empty 状态也有价值（全都闭馆时）
    if (g.state === "ok") {
      for (const c of g.candidates) seen.set(dedupeKey(c), c);
    }
    for (const c of g.closedOut) closedSeen.add(dedupeKey(c));
  }
  if (!seen.size && !closedSeen.size) return undefined;
  return {
    candidates: seen.size,
    closedSkipped: [...seen.values()].filter((c) => c.closedOn).length,
    closedOut: closedSeen.size,
  };
}

// ---------- 渲染（进 prompt） ----------

function candidateLine(c: GroundingCandidate): string {
  const parts: string[] = [`- ${c.name}`];
  if (c.area) parts.push(c.area);
  if (c.hours) parts.push(`营业 ${c.hours}`);
  if (c.closedOn) parts.push(`${c.closedOn} 闭馆${c.closedReason ? `（${c.closedReason}）` : ""}`);
  if (c.rating !== undefined) parts.push(`评分 ${c.rating}`);
  if (c.avgCostCny !== undefined) {
    parts.push(c.kind === "food" ? `人均约 ${c.avgCostCny} 元` : `门票/消费约 ${c.avgCostCny} 元`);
  }
  return parts.join("｜");
}

/**
 * 渲染成 prompt 片段。没有清单时返回空串（调用方直接跳过这一段，
 * 生成链路与改动前完全一致）。
 */
export function renderGroundingPrompt(g: Grounding): string {
  // unavailable = 事实层整体不可用 → 完全不注入（生成链路与改动前一致）
  if (g.state === "unavailable") return "";
  if (!g.candidates.length && !g.closedOut.length) return "";
  const sights = g.candidates.filter((c) => c.kind === "sight");
  const foods = g.candidates.filter((c) => c.kind === "food");
  const lines: string[] = [];
  if (g.candidates.length) {
    lines.push("【真实素材清单（高德实时核验：名称、位置、营业时间、评分、人均均已核实）】");
    lines.push(
      "以下地点真实存在。请优先从清单中选择行程点；清单确实满足不了需求时才用清单外的地点，且必须是真实存在的知名地点。",
    );
    if (sights.length) {
      lines.push("景点：");
      lines.push(...sights.map(candidateLine));
    }
    if (foods.length) {
      lines.push("餐饮：");
      lines.push(...foods.map(candidateLine));
    }
  }
  if (g.closedOut.length) {
    lines.push("【行程日期内全程闭馆，不要安排】");
    lines.push(
      ...g.closedOut.map((c) => `- ${c.name}${c.closedReason ? `（${c.closedReason}）` : ""}`),
    );
  }
  return lines.join("\n");
}
