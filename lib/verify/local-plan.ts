import { findCityPack, type CityPlace } from "@/lib/geo/city-packs";
import type { Plan } from "@/lib/types";
import { addDaysIso } from "./adapt";
import { TRIP_CHECK_SPEC_VERSION, type TripCheckDocument } from "./types";

export function localPlanCheckInput(plan: Plan) {
  const references = new Map<string, CityPlace>();
  const document: TripCheckDocument = {
    specVersion: TRIP_CHECK_SPEC_VERSION,
    city: plan.city,
    budgetCny: plan.budgetCny,
    days: plan.days.map((day, index) => {
      const date = addDaysIso(plan.startDate, index);
      const month = date ? Number(date.slice(5, 7)) : 0;
      const city = day.city ?? (plan.cities?.length ? undefined : plan.city);
      const pack = city ? findCityPack(city) : undefined;
      return {
        day: day.day,
        city: day.city,
        date,
        spots: day.spots.map((spot) => {
          // 导入文件可以声明任意出处和坐标。只有本机内置包能提供核验数据。
          const place =
            spot.type === "sight" && !spot.location && spot.navigationQuery
              ? pack?.places.find(
                  (entry) =>
                    entry.name === spot.name && entry.navigationQuery === spot.navigationQuery,
                )
              : undefined;
          if (place) references.set(place.id, place);
          const hours = place?.hoursByMonth?.find((entry) => entry.months.includes(month));
          return {
            name: spot.name,
            type: spot.type,
            time: spot.time,
            area: spot.area,
            costCny: spot.costCny,
            durationMin: spot.durationMin,
            ...(hours ? { hours: { openTime: hours.openTime } } : {}),
            ...(place
              ? {
                  verification: {
                    source: "manual",
                    existence: "hit",
                    hours: hours ? "hit" : "not_checked",
                  },
                }
              : {}),
          };
        }),
        // 文件里的路段可能是估算，省略耗时避免被引擎计入已核验交通。
      };
    }),
  };
  return { document, references: [...references.values()] };
}
