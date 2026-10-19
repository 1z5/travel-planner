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
// POI 验真/通勤估算的并发上限。原本取 5，真机接真实高德 key 复测时发现
// 个人 key 的 QPS 比预期低——日志里频繁出现 10021 CUQPS_HAS_EXCEEDED_THE_LIMIT，
// 每次都靠重试到第 3 次才成功（既拖慢又刷日志）。降到 3 降低峰值 QPS。
const VERIFY_CONCURRENCY = 3;

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

/**
 * 两个字符串的最长公共子串长度（字符级，动态规划）。
 * 地名/活动名都在 30 字内，短串足够快，不需要后缀自动机那类复杂结构。
 */
function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 名称匹配：用户写的名字是否已被行程覆盖。
 *
 * 为什么不能只用全字符串 includes：用户写「成都川剧变脸演出」，模型会**正确**
 * 落成具体场馆「蜀风雅韵川剧变脸演出(琴台路店)」——全串匹配不上就把正确执行
 * 误报成「未出现在行程中」，预警系统说谎（与住所字段当年踩的是同一个坑，
 * 见 CHANGELOG「住所/必游地 + 误报修复」）。必游地同样：「成都大熊猫基地」
 * vs 模型落成的「成都大熊猫繁育研究基地」。
 *
 * 匹配规则（任一命中即算覆盖）：
 * 1. 双向完整包含——用户给了确切名称，或模型用了更短的规范名
 * 2. 最长公共子串 ≥3 字——用户写简称/别称，模型补全了场馆或全称
 *    （3 字是校准值：「武侯祠」这类三字地名要能命中，而「测试必游地X」与
 *     fixture 各 POI 的公共子串仅 1 字，不会把漏排误放过）
 */
export function nameCovered(name: string, candidates: readonly string[]): boolean {
  const n = name.trim();
  if (!n) return false;
  return candidates.some((c) => {
    if (c.includes(n) || n.includes(c)) return true;
    return longestCommonSubstring(n, c) >= 3;
  });
}

/** 单日体检结果 */
export interface DayCheck {
  warnings: string[];       // 当天的预警（POI 未命中 / 通勤 / 节奏）
  unverified: string[];     // 因上游异常未能验真的 POI（≠不存在）
  transitUnknown: boolean;  // 当天通勤是否无法估算
  missCount: number;        // 当天「未在高德检索到」的 POI 数（境外场景汇总用）
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
  let missCount = 0;
  // 境外/无覆盖目的地由 finalizePlan 按**全局数据**判断（见 coverageNotice）：
  // 所有 POI 全 miss + 通勤全失败 = 高德不覆盖该区域。不在单日层面用城市名
  // 硬编码名单判断——不可维护，且用户可输入任何境外城市。

  // 1) POI 验真：景点和餐厅必须真实存在。
  //    有界并发 + 保序：warning 仍按当天顺序输出。
  if (!AMAP_MOCK) {
    const targets = day.spots
      .filter((s) => s.type === "sight" || s.type === "food")
      .map((s) => ({ spot: s, name: s.name, day: day.day }));
    const results = await mapLimit(targets, VERIFY_CONCURRENCY, async (t) => ({
      t,
      r: await lookupPoi(plan.city, t.name, input.scope),
    }));
    for (const { t, r } of results) {
      if (r.state === "miss") {
        missCount += 1;
        warnings.push(
          `第 ${t.day} 天「${t.name}」未在高德检索到，可能名称有误或已关闭，出发前请自行确认`,
        );
      } else if (r.state === "error") {
        unverified.push(t.name);
      } else if (r.poi.location) {
        // 命中时把坐标存回 spot——「行中」定位要算「我离这站多远」，而验真是
        // 唯一拿到真实坐标的时机（LLM 不输出坐标）。MOCK 模式整个块不跑，
        // 所以不会存入假坐标。
        t.spot.location = r.poi.location;
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
      r: await transitMinutes(plan.city, seg.from, seg.to, input.scope),
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

  return { warnings, unverified, transitUnknown, missCount };
}

/** plan 级收尾所需的上下文（由调用方逐天累积而来） */
export interface FinalizeCtx {
  warnings: string[];
  unverified: string[];
  transitUnknownDays: number[];
  grandTotal: number;
  /** 全天「未在高德检索到」的 POI 总数 */
  missCount: number;
  /** 全天参与验真的 POI 总数（sight + food） */
  poiTotal: number;
}

/**
 * 合法日历日期判断：格式对 **且** 能 round-trip。
 *
 * 只查格式不够——API 的 DT_RE 是纯格式正则，"2026-02-30T09:00" 能过 schema，
 * 而 `new Date("2026-02-30")` 会静默规范成 3 月 2 日。拿这种值去做日期运算
 * （toISOString）会抛 RangeError，而 finalizePlan 没有 try/catch 兜底。
 * round-trip 对不上就判定非法，调用方据此跳过而不是崩。
 */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  // 必须先挡 NaN：月越界（"2026-13-01"）时 V8 给的是 Invalid Date，
  // 直接 toISOString() 会抛 RangeError——guard 自己就成了崩溃源。
  // 日越界（"2026-02-30"）则会被静默滚动成 3 月 2 日，靠下面的
  // round-trip 对不上来判伪。
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

/** "YYYY-MM-DD" + n 天 → "YYYY-MM-DD"（UTC 算术避免时区漂移；与 weather/ics 同口径） */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * plan 级收尾：预算核对 + 用户硬约束核验 + 验真完成度 + 系统提示。
 * 分日路径在所有天生成完后调用一次；单次路径在 validatePlan 末尾调用。
 */
export function finalizePlan(plan: Plan, input: PlanInput, ctx: FinalizeCtx): void {
  const { warnings, unverified, transitUnknownDays, grandTotal, missCount, poiTotal } = ctx;

  // 无覆盖区域（典型：境外目的地）：高德只覆盖国内 POI，境外地点**全部**搜不到。
  // 此时逐条「未在高德检索到」是把产品的数据边界说成用户的问题（文案还暗示
  // 「可能名称有误或已关闭」），看着一片红却不知道真正原因。
  //
  // 判断只用可靠信号「所有 POI 都 miss」，**不**叠加「通勤也全部失败」——
  // 后者取决于 QPS 是否抖动（瞬时错误），把瞬时故障误判成「无覆盖」会冤枉
  // 一个本该正常的国内行程。同理也不用城市名硬编码名单（不可维护，且用户可
  // 输入任何境外城市）。poiTotal>=4 防止小行程偶发全 miss 的误报。
  const uncovered = !AMAP_MOCK && poiTotal >= 4 && missCount === poiTotal;
  if (uncovered) {
    const names = plan.days
      .flatMap((d) => d.spots.filter((x) => x.type === "sight" || x.type === "food"))
      .slice(0, 3)
      .map((x) => x.name)
      .join("、");
    warnings.push(
      `「${plan.city}」疑似境外或无 POI 覆盖的目的地：${poiTotal} 个景点/餐厅全部未在高德检索到。本产品的 POI 验真与通勤估算依赖高德（仅覆盖国内），因此这份行程的**景点真实性未经核查、站点间通勤为估算兜底值**，都需要你自行核实——下方逐条「未检索到」是这个原因，不是名称打错`,
    );
    if (names) {
      warnings.push(`未检索到的地点包括：${names} 等 ${poiTotal} 个，均为境外/无覆盖数据所致`);
    }
  }

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

  // 用户硬约束核验：prompt 要求了，这里验证承诺是否兑现。
  // 名称匹配用 nameCovered（见其注释）——用户写简称、模型落成场馆全称是
  // 正确执行，全字符串匹配会把它误报成漏排。
  const spotNames = plan.days.flatMap((d) => d.spots.map((s) => s.name));
  for (const mv of input.mustVisit ?? []) {
    if (!nameCovered(mv, spotNames)) {
      warnings.push(
        `必游地「${mv}」未出现在行程中——可重试，或检查名称是否与当地叫法一致`,
      );
    }
  }
  // 重点活动核验：与必游地同为硬约束（漏排告警），另加日期与时间合理性检查——
  // 排错天 / 排在开始时间之后 = 用户错过开场，都是比漏排更隐蔽的问题
  const daySpots = plan.days.flatMap((d) => d.spots.map((s) => ({ s, day: d.day })));
  // 能把「第 N 天」换算成具体日期，才谈得上校验日期。startDate 要存在且是
  // 合法日历日期（isRealDate 已挡掉 2026-02-30 这类）。推算不了就不猜——
  // 与天气模块同一立场：没有依据就不下判断，而不是编一个
  const canDate = !!plan.startDate && isRealDate(plan.startDate);
  for (const ev of input.events ?? []) {
    // 承载活动的 spot：用名称匹配找（用户写「成都川剧变脸演出」、模型落成
    // 「蜀风雅韵川剧变脸演出(琴台路店)」也要能对上）。用 filter 而非 find：
    // 多日活动（连展/多场次）可能落在多天，日期校验要看有没有任一天对得上
    const matches = daySpots.filter((x) => nameCovered(ev.name, [x.s.name]));
    if (!matches.length) {
      warnings.push(
        `重点活动「${ev.name}」未出现在行程中——可重试，或检查名称是否与当地叫法一致`,
      );
      continue;
    }
    // 日期校验：用户指定了 date，就必须有匹配的 spot 落在对应那天。
    // 此前 date 只喂给 prompt 和 UI 展示，校验完全没看它——排在错天会无声
    // 通过，而「活动在错的一天」对用户是硬伤（演唱会/赛事日期买定离手）
    if (ev.date && canDate && isRealDate(ev.date)) {
      const onRightDay = matches.some((x) => addDays(plan.startDate!, x.day - 1) === ev.date);
      if (!onRightDay) {
        const placed = matches.map((x) => `第 ${x.day} 天`).join("、");
        warnings.push(
          `重点活动「${ev.name}」被排在${placed}，但你指定的日期是 ${ev.date}——对不上，建议核对`,
        );
      }
    }
    if (!ev.time) continue;
    // 时间校验用第一个匹配的 spot（与既有行为一致）
    const spotStart = matches[0].s.time.match(/^(\d{1,2}):(\d{2})/);
    if (!spotStart) continue;
    const toMin = (h: string, m: string) => Number(h) * 60 + Number(m);
    const startMin = toMin(spotStart[1], spotStart[2]);
    const evMin = toMin(ev.time.slice(0, 2), ev.time.slice(3, 5));
    if (startMin > evMin) {
      // 用匹配到的时分而不是 time.slice(0,5)：单位数小时（"9:30-…"）时
      // slice 会切出 "9:30-" 这种残缺串
      warnings.push(
        `重点活动「${ev.name}」被排在 ${spotStart[1]}:${spotStart[2]} 开始，晚于活动时间 ${ev.time}，可能错过开场——建议提前到场`,
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
  // 回填用户预算：预算使用率（lib/budget.ts）的唯一依据。
  // 放在 totalCostCny 旁边——两者是同一组「钱」的数据，避免上游遗漏这一行。
  plan.budgetCny = input.budget;
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

  let missCount = 0;
  let poiTotal = 0;
  for (const day of plan.days) {
    const check = await validateDay(plan, day, input);
    warnings.push(...check.warnings);
    unverified.push(...check.unverified);
    if (check.transitUnknown) transitUnknownDays.push(day.day);
    grandTotal += day.dailyCostCny;
    missCount += check.missCount;
    poiTotal += day.spots.filter((s) => s.type === "sight" || s.type === "food").length;
  }

  finalizePlan(plan, input, {
    warnings, unverified, transitUnknownDays, grandTotal, missCount, poiTotal,
  });
  return plan;
}
