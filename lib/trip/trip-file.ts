import { z } from "zod";
import type { Plan } from "@/lib/types";
import { buildIcs } from "../plan/ics";
import { isTripTimeZone } from "./trip-day";

export const TRIP_FILE_MAX_BYTES = 2 * 1024 * 1024;

const text = z.string().max(4000);
const nonnegative = z.number().min(0);
const date = z.iso.date();
const mode = z.enum(["walking", "bicycling", "driving", "auto"]);
const sourceUrl = z.url({ protocol: /^https$/ }).max(2048);
const spot = z.object({
  stopId: z.uuid().optional(),
  period: z.enum(["morning", "lunch", "afternoon", "dinner", "evening"]),
  type: z.enum(["sight", "food", "hotel", "transport", "shopping", "activity"]),
  name: text.min(1),
  time: text,
  area: text,
  durationMin: nonnegative,
  costCny: nonnegative,
  reason: text,
  rainBackup: text.optional(),
  navigationQuery: z.string().trim().min(1).max(160).optional(),
  placeSource: z.object({ name: z.string().trim().min(1).max(100), url: sourceUrl }).optional(),
  openingHoursNote: z
    .object({
      hours: z.string().trim().min(1).max(240),
      source: z.string().trim().min(1).max(100),
      url: sourceUrl.optional(),
    })
    .optional(),
  location: z
    .string()
    .regex(/^-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/)
    .optional(),
});

const planSchema = z.object({
  city: text.min(1),
  cities: z
    .array(z.object({ city: text.min(1), days: z.number().int().positive() }))
    .max(30)
    .optional(),
  startDate: date.optional(),
  timeZone: z.string().max(100).refine(isTripTimeZone).optional(),
  endDate: date.optional(),
  startAt: text.optional(),
  endAt: text.optional(),
  summary: text,
  days: z
    .array(
      z.object({
        day: z.number().int().positive(),
        city: text.optional(),
        theme: text,
        spots: z.array(spot).max(100),
        dailyCostCny: nonnegative,
        transitMin: nonnegative,
        transitKnown: z.boolean().optional(),
        legs: z
          .array(
            z.object({
              from: text,
              to: text,
              mode,
              distanceM: nonnegative,
              durationSec: nonnegative,
              steps: z.array(text).max(100),
            }),
          )
          .max(100)
          .optional(),
      }),
    )
    .min(1)
    .max(30),
  totalCostCny: nonnegative,
  budgetCny: nonnegative.optional(),
  tips: z.array(text).max(100),
});

const marksSchema = z.record(z.uuid(), z.enum(["arrived", "skipped"]));
export type LocalMarks = z.infer<typeof marksSchema>;

const fileSchema = z.object({
  format: z.literal("ai-travel-companion"),
  version: z.literal(1),
  plan: planSchema,
  marks: marksSchema.optional(),
});

// 文件只携带计划。导入到新设备时，文件里的数据不能给它授予核验结论或云端权限。
export function serializeTripFile(plan: Plan, marks?: LocalMarks): string {
  const file = fileSchema.parse({ format: "ai-travel-companion", version: 1, plan, marks });
  const json = JSON.stringify(file, null, 2);
  if (new Blob([json]).size > TRIP_FILE_MAX_BYTES) {
    throw new Error("行程文件超过大小限制");
  }
  return json;
}

export function readTripFile(json: string): Plan {
  return readTripBackup(json).plan;
}

export function readTripBackup(json: string): { plan: Plan; marks?: LocalMarks } {
  const { plan, marks } = fileSchema.parse(JSON.parse(json));
  return { plan: { ...plan, verified: false, warnings: [] }, marks };
}

export function downloadTripFile(plan: Plan, marks?: LocalMarks) {
  const blob = new Blob([serializeTripFile(plan, marks)], { type: "application/json" });
  downloadBlob(blob, marks ? "travel-companion.backup.json" : "travel-companion.trip.json");
}

export function downloadTripCalendar(plan: Plan) {
  downloadBlob(
    new Blob([buildIcs(plan)], { type: "text/calendar;charset=utf-8" }),
    "travel-companion.ics",
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // 让浏览器先接管下载。
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
