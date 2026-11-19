import type { Plan } from "@/lib/types";
import { serializeTripFile, type LocalMarks } from "./trip-file";

const KEY = "tp.local-trip-files.v1";

export function listLocalTrips(): string[] {
  const files: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    throw new Error("本机行程格式错误");
  }
  return files;
}

export function saveLocalTrip(plan: Plan, previous?: string, marks?: LocalMarks): string {
  const file = serializeTripFile(plan, marks);
  const files = listLocalTrips().filter((other) => other !== file && other !== previous);
  localStorage.setItem(KEY, JSON.stringify([file, ...files]));
  return file;
}

export function removeLocalTrip(file: string) {
  localStorage.setItem(KEY, JSON.stringify(listLocalTrips().filter((other) => other !== file)));
}

export function assignLocalStopIds(plan: Plan): Plan {
  const seen = new Set<string>();
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      spots: day.spots.map((spot) => {
        const stopId = spot.stopId && !seen.has(spot.stopId) ? spot.stopId : crypto.randomUUID();
        seen.add(stopId);
        return { ...spot, stopId };
      }),
    })),
  };
}
