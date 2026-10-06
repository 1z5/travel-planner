import "server-only";
import { AMAP_MOCK, transitMinutes, verifyPoi } from "./amap";
import type { Plan, PlanInput } from "./types";

// 幻觉治理 + 行程体检。
// 定位：不改写 LLM 的行程（那是下一版的事），只做「标记 + 预警」——
// 用户看到的每个风险都摊开说，而不是假装完美。

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

function fmtMin(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h} 小时 ${m} 分钟` : `${m} 分钟`;
}

export async function validatePlan(plan: Plan, input: PlanInput): Promise<Plan> {
  const warnings: string[] = [];
  let grandTotal = 0;

  for (const day of plan.days) {
    // 1) POI 验真：景点和餐厅必须真实存在
    for (const spot of day.spots) {
      if (spot.type !== "sight" && spot.type !== "food") continue;
      const poi = await verifyPoi(plan.city, spot.name);
      if (!poi) {
        warnings.push(
          `第 ${day.day} 天「${spot.name}」未在高德检索到，可能名称有误或已关闭，出发前请自行确认`,
        );
      }
    }

    // 2) 通勤：顺序累加相邻站点间的估算时间。
    // MOCK 模式下不估算——哈希假数据只会制造「疑似绕路」的虚假预警，
    // 节奏判定也退化为纯停留时长（avoids 假数据污染两个指标）。
    let transit = 0;
    if (!AMAP_MOCK) {
      for (let i = 0; i < day.spots.length - 1; i++) {
        transit += await transitMinutes(plan.city, day.spots[i].name, day.spots[i + 1].name);
      }
      if (transit > TRANSIT_WARN_MIN) {
        warnings.push(
          `第 ${day.day} 天站点间通勤约 ${fmtMin(transit)}，偏长，可能存在绕路，建议合并同区域景点`,
        );
      }
    }
    day.transitMin = transit;

    // 3) 节奏：停留 + 通勤
    const active = day.spots.reduce((s, x) => s + x.durationMin, 0) + transit;
    const pace = input.pace ?? "balanced";
    if (active > PACE_DAY_MIN[pace]) {
      warnings.push(
        `第 ${day.day} 天安排约 ${fmtMin(active)}，超出${PACE_LABEL[pace]}节奏上限（${PACE_DAY_MIN[pace] / 60} 小时），可删减 1 个景点或改选更紧凑节奏`,
      );
    } else if (active < LOOSE_DAY_MIN) {
      warnings.push(`第 ${day.day} 天安排约 ${fmtMin(active)}，偏松，可加一个景点或放慢节奏`);
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
  return plan;
}
