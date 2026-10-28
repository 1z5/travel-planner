// ============================================================
// 开放文档/请求的服务端校验（zod）
//
// 与 schema.ts 的分工：JSON Schema 是对外契约（宽松、允许扩展字段），这里是
// 服务端解析（归一化、限额、中文错误信息、拒绝越界数据）。两者字段必须同步，
// tests/lib/verify/validate.test.ts 会校验「schema 声明的必填项 zod 也必填」。
//
// 为什么所有错误都给 path：开放 API 的调用方是开发者/agent，报错必须能定位到
// 具体字段（"days.0.spots.2.time 不是合法时段"），而不是一句"格式错误"。
// ============================================================

import { z } from "zod";
import {
  TRIP_CHECK_LIMITS,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckDocument,
  type TripCheckOptions,
} from "./types";

const finiteNumber = z.number().refine((n) => Number.isFinite(n), "必须是有限数字");

const SourceSchema = z.enum(["amap", "google_places", "osm", "manual", "mock", "other"]);
const FactStateSchema = z.enum(["hit", "miss", "error", "not_checked"]);

const ProvenanceEntrySchema = z.object({
  source: SourceSchema,
  checkedAt: z.string().max(40).optional(),
});

const ProvenanceSchema = z.object({
  poi: ProvenanceEntrySchema.optional(),
  routes: ProvenanceEntrySchema.optional(),
  hours: ProvenanceEntrySchema.optional(),
});

const HoursSchema = z.object({
  openTime: z.string().max(500).optional(),
  openTime2: z.string().max(2000).optional(),
  temporarilyClosed: z.boolean().optional(),
});

const VerificationSchema = z.object({
  source: SourceSchema.optional(),
  existence: FactStateSchema.optional(),
  hours: FactStateSchema.optional(),
  checkedAt: z.string().max(40).optional(),
});

const SpotSchema = z.object({
  name: z.string().trim().min(1, "点位名称不能为空").max(TRIP_CHECK_LIMITS.maxNameChars),
  time: z.string().trim().min(1, "时间不能为空").max(40),
  type: z.enum(["sight", "food", "hotel", "transport", "shopping", "activity"]).optional(),
  durationMin: finiteNumber.positive("停留时长必须大于 0").max(1440).optional(),
  costCny: finiteNumber.min(0).max(1_000_000).optional(),
  area: z.string().trim().max(120).optional(),
  location: z.string().trim().max(80).optional(),
  hours: HoursSchema.optional(),
  verification: VerificationSchema.optional(),
});

const LegSchema = z.object({
  from: z.string().trim().min(1).max(TRIP_CHECK_LIMITS.maxNameChars),
  to: z.string().trim().min(1).max(TRIP_CHECK_LIMITS.maxNameChars),
  mode: z.enum(["walking", "bicycling", "driving", "transit", "auto"]).optional(),
  durationMin: finiteNumber.min(0).max(1440).optional(),
  distanceM: finiteNumber.min(0).max(10_000_000).optional(),
  source: SourceSchema.optional(),
  state: FactStateSchema.optional(),
});

const DaySchema = z.object({
  day: z.number().int("day 必须是整数").min(1).max(365),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD")
    .optional(),
  city: z.string().trim().max(40).optional(),
  spots: z
    .array(SpotSchema)
    .max(
      TRIP_CHECK_LIMITS.maxSpotsPerDay,
      `单日点位不能超过 ${TRIP_CHECK_LIMITS.maxSpotsPerDay} 个`,
    ),
  legs: z.array(LegSchema).max(TRIP_CHECK_LIMITS.maxSpotsPerDay).optional(),
});

/** 文档校验（限额 + day 唯一） */
export const TripCheckDocumentSchema = z
  .object({
    specVersion: z.literal(TRIP_CHECK_SPEC_VERSION, {
      message: `specVersion 必须是 "${TRIP_CHECK_SPEC_VERSION}"`,
    }),
    id: z.string().trim().max(120).optional(),
    city: z.string().trim().max(40).optional(),
    budgetCny: finiteNumber.min(0).max(TRIP_CHECK_LIMITS.maxBudgetCny).optional(),
    provenance: ProvenanceSchema.optional(),
    days: z
      .array(DaySchema)
      .min(1, "至少需要 1 天")
      .max(TRIP_CHECK_LIMITS.maxDays, `行程天数不能超过 ${TRIP_CHECK_LIMITS.maxDays} 天`),
  })
  .refine((doc) => new Set(doc.days.map((d) => d.day)).size === doc.days.length, {
    message: "day 编号必须唯一",
    path: ["days"],
  })
  .refine((doc) => doc.days.reduce((n, d) => n + d.spots.length, 0) <= TRIP_CHECK_LIMITS.maxSpots, {
    message: `点位总数不能超过 ${TRIP_CHECK_LIMITS.maxSpots} 个`,
    path: ["days"],
  });

/** options 校验（判定口径） */
export const TripCheckOptionsSchema = z.object({
  pace: z.enum(["relaxed", "balanced", "packed"]).optional(),
});

/** POST /api/verify 请求体：document 与 shareId 二选一 */
const VerifyRequestBaseSchema = z.object({
  document: TripCheckDocumentSchema.optional(),
  shareId: z
    .string()
    .trim()
    .regex(/^share_[A-Za-z0-9_-]{8,64}$/, "shareId 格式不正确（应以 share_ 开头）")
    .optional(),
  options: TripCheckOptionsSchema.optional(),
});

export const VerifyRequestSchema = VerifyRequestBaseSchema.refine(
  (v) => (v.document === undefined) !== (v.shareId === undefined),
  { message: "document 与 shareId 必须且只能提供一个", path: ["document"] },
);

export interface ParseError {
  path: string;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: ParseError[] };

function toErrors(error: z.ZodError): ParseError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

/** 解析请求体（未知字段会被忽略——开放标准允许扩展字段） */
export function parseVerifyRequest(
  input: unknown,
): ParseResult<{ document?: TripCheckDocument; shareId?: string; options: TripCheckOptions }> {
  const parsed = VerifyRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toErrors(parsed.error) };
  return {
    ok: true,
    value: {
      // zod 推断出的字面量类型与 string 兼容；显式收窄为对外类型
      ...(parsed.data.document ? { document: parsed.data.document as TripCheckDocument } : {}),
      ...(parsed.data.shareId ? { shareId: parsed.data.shareId } : {}),
      options: parsed.data.options ?? {},
    },
  };
}

/** 解析一份单独的开放文档（MCP 工具/内部复用） */
export function parseTripCheckDocument(input: unknown): ParseResult<TripCheckDocument> {
  const parsed = TripCheckDocumentSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: toErrors(parsed.error) };
  return { ok: true, value: parsed.data as TripCheckDocument };
}
