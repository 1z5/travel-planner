import type { Plan } from "@/lib/types";
import { tripClock } from "@/lib/trip/trip-day";
import { tokyoCityPack } from "@/lib/geo/city-packs";

export function tokyoLocalTrip(now?: Date): Plan {
  const { city, timeZone, places } = tokyoCityPack;
  const temple = places.find(({ id }) => id === "senso-ji")!;
  const park = places.find(({ id }) => id === "sumida-park-taito")!;
  const { todayIso } = tripClock(timeZone, now);
  return {
    city,
    timeZone,
    startDate: todayIso,
    endDate: todayIso,
    summary: "从浅草步行到隅田川。示例日期为东京当地今天，路线时长仅供演示参考。",
    days: [
      {
        day: 1,
        theme: "浅草与隅田川",
        spots: [
          {
            period: "morning",
            type: "sight",
            ...temple,
            time: "09:00-10:00",
            durationMin: 60,
            costCny: 0,
            reason: "",
          },
          {
            period: "morning",
            type: "sight",
            ...park,
            time: "10:30-11:30",
            durationMin: 60,
            costCny: 0,
            reason: "",
          },
        ],
        legs: [
          {
            from: temple.name,
            to: park.name,
            mode: "walking",
            distanceM: 750,
            durationSec: 660,
            steps: [],
          },
        ],
        dailyCostCny: 0,
        transitMin: 11,
      },
    ],
    totalCostCny: 0,
    tips: [],
    warnings: [],
    verified: false,
  };
}
