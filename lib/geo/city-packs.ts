import type { PlanSpot } from "@/lib/types";
import paris from "./city-packs/paris.json";
import tokyo from "./city-packs/tokyo.json";

export type CityPlace = {
  id: string;
  hoursByMonth?: { months: number[]; openTime: string }[];
} & Pick<PlanSpot, "name" | "area" | "navigationQuery" | "placeSource" | "openingHoursNote">;

export type CityPack = { city: string; timeZone: string; places: CityPlace[] };

export const tokyoCityPack: CityPack = tokyo;

export function findCityPack(city: string): CityPack | undefined {
  const name = city.trim();
  if (/^(东京|東京|tokyo)$/i.test(name)) return tokyoCityPack;
  if (/^(巴黎|paris)$/i.test(name)) return paris;
}
