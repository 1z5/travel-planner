import { z } from "zod";
import type { Plan } from "@/lib/types";
import { buildIcs } from "../plan/ics";
import { JOURNAL_PHOTO_BYTES, JOURNAL_PHOTO_EDGE } from "./journal-photo";
import { isTripTimeZone } from "./trip-day";

export const TRIP_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const TRIP_BACKUP_MAX_BYTES = 32 * 1024 * 1024;

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

export const MAX_JOURNAL_ENTRIES = 200;
const journalEntry = z.object({
  id: z.uuid(),
  at: z.iso.datetime(),
  text: z.string().trim().min(1).max(1000),
  place: text.optional(),
  photo: z
    .object({
      src: z
        .string()
        .max(23 + Math.ceil(JOURNAL_PHOTO_BYTES / 3) * 4)
        .regex(/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/),
      width: z.number().int().min(1).max(JOURNAL_PHOTO_EDGE),
      height: z.number().int().min(1).max(JOURNAL_PHOTO_EDGE),
    })
    .optional(),
});
export type JournalEntry = z.infer<typeof journalEntry>;

export const footprintPosition = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  accuracy: nonnegative,
});
export type FootprintPosition = z.infer<typeof footprintPosition>;
const arrivalsSchema = z.record(
  z.uuid(),
  z.object({
    place: text.min(1),
    at: z.iso.datetime().optional(),
    position: footprintPosition.optional(),
  }),
);
export type LocalArrivals = z.infer<typeof arrivalsSchema>;
export const MAX_WALK_TITLE_LENGTH = 64;
export interface TripProgress {
  marks?: LocalMarks;
  notes?: JournalEntry[];
  arrivals?: LocalArrivals;
  walk?: true;
  title?: string;
}

const fileSchema = z.object({
  format: z.literal("ai-travel-companion"),
  version: z.union([z.literal(1), z.literal(2)]),
  plan: planSchema,
  walk: z.literal(true).optional(),
  title: z.string().trim().min(1).max(MAX_WALK_TITLE_LENGTH).optional(),
  marks: marksSchema.optional(),
  arrivals: arrivalsSchema.optional(),
  notes: z
    .array(journalEntry)
    .max(MAX_JOURNAL_ENTRIES)
    .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length)
    .optional(),
});

// 普通导出省略私人进展。导入不会授予核验结论或云端权限。
export function serializeTripFile(plan: Plan, progress?: TripProgress): string {
  const { marks, notes, arrivals, walk, title } = progress ?? {};
  const file = fileSchema.parse({
    format: "ai-travel-companion",
    version: 1,
    plan,
    marks,
    notes,
    arrivals,
    walk,
    title,
  });
  const json = JSON.stringify(file, null, 2);
  const size = new Blob([json]).size;
  if (size <= TRIP_FILE_MAX_BYTES) return json;
  if (progress && size <= TRIP_BACKUP_MAX_BYTES)
    return JSON.stringify({ ...file, version: 2 }, null, 2);
  throw new Error(progress ? "私人备份超过 32 MB。" : "行程文件超过 2 MB。");
}

export function readTripFile(json: string): Plan {
  return readTripBackup(json).plan;
}

export function readTripBackup(json: string): { plan: Plan } & TripProgress {
  const size = new Blob([json]).size;
  if (size > TRIP_BACKUP_MAX_BYTES) throw new Error("备份文件不能超过 32 MB。");
  const value = JSON.parse(json);
  if (value?.version === 1 && size > TRIP_FILE_MAX_BYTES)
    throw new Error("旧版行程文件不能超过 2 MB。");
  return parseTripBackup(value);
}

export function parseTripBackup(value: unknown): { plan: Plan } & TripProgress {
  const { plan, marks, notes, arrivals, walk, title } = fileSchema.parse(value);
  return { plan: { ...plan, verified: false, warnings: [] }, marks, notes, arrivals, walk, title };
}

export function downloadTripFile(plan: Plan, progress?: TripProgress) {
  const blob = new Blob([serializeTripFile(plan, progress)], {
    type: "application/json",
  });
  downloadBlob(blob, progress ? "travel-companion.backup.json" : "travel-companion.trip.json");
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
