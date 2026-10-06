import "server-only";
import { AMAP_MOCK, transitMinutes, verifyPoi } from "./amap";
import type { Plan, PlanInput } from "./types";

// 幻觉治理 + 行程体检。
// 定位：不改写 LLM 的行程（那是下一版的事），只做「标记 + 预警」——
// 用户看到的每个风险都摊开说，而不是假装完美。

const TRANSIT_WARN_MIN = 120;   // 当天通勤超过 2 小时视为疑似绕路
const RELAX_DAY_MIN = 10 * 60;  // 每天净时长上限 10h
const LOOSE_DAY_MIN = 5 * 60;   // 每天净时长低于 5h 视为过松
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
    if (active > RELAX_DAY_MIN) {
      warnings.push(`第 ${day.day} 天安排约 ${fmtMin(active)}，偏满，可考虑删减 1 个景点`);
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
    const mentioned = plan.days.some((d) =>
      d.spots.some((s) => s.name.includes(hotel) || s.area.includes(hotel)));
    if (!mentioned) {
      warnings.push(`住所「${hotel}」未体现在行程中——行程应以它为每日出发点`);
    }
  }

  plan.totalCostCny = grandTotal;
  plan.warnings = warnings;
  plan.verified = !AMAP_MOCK;
  return plan;
}
