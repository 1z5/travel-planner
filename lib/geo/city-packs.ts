import type { PlanSpot } from "@/lib/types";
import tokyo from "./city-packs/tokyo.json";

export type CityPlace = {
  id: string;
  hoursByMonth?: { months: number[]; openTime: string }[];
} & Pick<PlanSpot, "name" | "area" | "navigationQuery" | "placeSource" | "openingHoursNote">;

export const tokyoCityPack: { city: string; timeZone: string; places: CityPlace[] } = tokyo;

export function findCityPack(city: string) {
  return /^(东京|東京|tokyo)$/i.test(city.trim()) ? tokyoCityPack : undefined;
}
