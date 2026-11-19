import type { PlanSpot } from "@/lib/types";
import { parseLngLat } from "./spatial";

export function spotNavigationUrl(spot: PlanSpot, fromFile = false): string | undefined {
  if (fromFile && spot.navigationQuery) {
    const params = new URLSearchParams({ api: "1", destination: spot.navigationQuery });
    return `https://www.google.com/maps/dir/?${params}`;
  }
  const location = spot.location?.trim();
  if (!location) return;
  const point = parseLngLat(location);
  if (!point || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) return;
  return (
    `https://uri.amap.com/navigation?to=${encodeURIComponent(location).replace("%2C", ",")},${encodeURIComponent(spot.name)}` +
    "&mode=car&policy=1&src=travelplanner&coordinate=gaode&callnative=1"
  );
}
