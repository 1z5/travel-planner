import type { Plan } from "@/lib/types";
import type { LocalArrivals, LocalMarks } from "./trip-file";
import { localTodayIso } from "./trip-day";

export function walkPlan(now = new Date()): Plan {
  const date = localTodayIso(now);
  return {
    city: "随走手记",
    startDate: date,
    endDate: date,
    summary: "",
    days: [{ day: 1, theme: "随走", spots: [], dailyCostCny: 0, transitMin: 0 }],
    totalCostCny: 0,
    tips: [],
    verified: false,
    warnings: [],
  };
}

// 旧备份只记录到达状态。当用户移除计划站点时也要保留这段经历，时间留空。
export function tripArrivals(
  plan: Plan,
  marks: LocalMarks | undefined,
  arrivals: LocalArrivals = {},
): LocalArrivals {
  const result = { ...arrivals };
  for (const day of plan.days) {
    for (const spot of day.spots) {
      if (spot.stopId && marks?.[spot.stopId] === "arrived" && !result[spot.stopId])
        result[spot.stopId] = { place: spot.name };
    }
  }
  return result;
}
