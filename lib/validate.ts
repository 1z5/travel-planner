import "server-only";
import { AMAP_MOCK, lookupPoi, transitMinutes } from "./amap";
import { mapLimit } from "./concurrency";
import type { Plan, PlanInput } from "./types";

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
// POI 验真/通勤估算的并发上限：一次 4 天行程约 25 个 POI + 20 段通勤，
// 串行要多等十几秒；个人高德 key 有 QPS 限制，5 路是速度与配额的安全档
const VERIFY_CONCURRENCY = 5;

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

export async function validatePlan(plan: Plan, input: PlanInput): Promise<Plan> {
  const warnings: string[] = [];
  const unverified: string[] = [];      // 因上游异常未能验真的 POI（≠不存在）
  const transitUnknownDays: number[] = []; // 通勤无法估算的天
  let grandTotal = 0;

  // 1) POI 验真：景点和餐厅必须真实存在。
  //    有界并发 + 保序：warning 仍按「天 → 当天顺序」输出，与串行版一致。
  if (!AMAP_MOCK) {
    const targets = plan.days.flatMap((d) =>
      d.spots
        .filter((s) => s.type === "sight" || s.type === "food")
        .map((s) => ({ name: s.name, day: d.day })),
    );
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

  for (const day of plan.days) {
    // 2) 通勤：相邻站点间估算，有界并发（段与段互不依赖）。
    //    MOCK 模式下不估算——哈希假数据只会制造「疑似绕路」的虚假预警，
    //    节奏判定也退化为纯停留时长（avoids 假数据污染两个指标）。
    let transit = 0;
    let transitUnknown = false;
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
      if (transitUnknown) {
        transitUnknownDays.push(day.day);
      } else if (transit > TRANSIT_WARN_MIN) {
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

    // 4) 预算
    day.dailyCostCny = day.spots.reduce((s, x) => s + x.costCny, 0);
    grandTotal += day.dailyCostCny;
  }

  if (grandTotal > input.budget * BUDGET_OVER) {
    warnings.push(
      `行程合计人均约 ${grandTotal} 元，超出预算 ${input.budget} 元 ${Math.round((grandTotal / input.budget - 1) * 100)}%，注意控制`,
    );
  }

  // 5) 用户硬约束核验：prompt 要求了，这里验证承诺是否兑现
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
  return plan;
}
