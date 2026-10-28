import { describe, expect, it } from "vitest";
import {
  parseTripCheckDocument,
  parseVerifyRequest,
  TripCheckDocumentSchema,
} from "@/lib/verify/validate";
import { TRIP_CHECK_JSON_SCHEMA } from "@/lib/verify/schema";
import { getSample } from "@/lib/verify/samples";

const verified = getSample("verified")!.document;

describe("parseVerifyRequest · 请求体校验", () => {
  it("document 与 shareId 必须二选一", () => {
    expect(parseVerifyRequest({ document: verified }).ok).toBe(true);
    expect(parseVerifyRequest({ shareId: "share_abcdefgh1234" }).ok).toBe(true);

    const both = parseVerifyRequest({ document: verified, shareId: "share_abcdefgh1234" });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.errors[0].message).toContain("只能提供一个");

    const neither = parseVerifyRequest({});
    expect(neither.ok).toBe(false);
  });

  it("shareId 格式不对 → 400（path 指到 shareId）", () => {
    const r = parseVerifyRequest({ shareId: "not-a-share-id" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.path === "shareId")).toBe(true);
    }
  });

  it("options.pace 只接受三档", () => {
    expect(parseVerifyRequest({ document: verified, options: { pace: "relaxed" } }).ok).toBe(true);
    const bad = parseVerifyRequest({ document: verified, options: { pace: "extreme" } });
    expect(bad.ok).toBe(false);
  });

  it("合法文档：通过并保留 pace 默认空对象", () => {
    const r = parseVerifyRequest({ document: verified });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.options).toEqual({});
  });
});

describe("parseTripCheckDocument · 开放文档校验", () => {
  it("三份示例文档全部合法", () => {
    for (const id of ["verified", "blocked", "unverified"] as const) {
      expect(parseTripCheckDocument(getSample(id)!.document).ok).toBe(true);
    }
  });

  it("specVersion 不对 → 错误 path 指到 specVersion", () => {
    const r = parseTripCheckDocument({ ...verified, specVersion: "trip-check/9.9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path === "specVersion")).toBe(true);
  });

  it("day 编号重复 → 拒绝", () => {
    const r = parseTripCheckDocument({
      specVersion: "trip-check/0.1",
      days: [
        { day: 1, spots: [] },
        { day: 1, spots: [] },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toContain("唯一");
  });

  it("单日点位超限 → 拒绝（防滥用边界）", () => {
    const spots = Array.from({ length: 41 }, (_, i) => ({ name: `点${i}`, time: "09:00-10:00" }));
    const r = parseTripCheckDocument({
      specVersion: "trip-check/0.1",
      days: [{ day: 1, spots }],
    });
    expect(r.ok).toBe(false);
  });

  it("允许未知扩展字段（开放标准要能演进）", () => {
    const withExtras = {
      ...verified,
      x_vendor: { foo: "bar" },
      days: verified.days.map((d) => ({ ...d, x_note: "扩展" })),
    };
    expect(parseTripCheckDocument(withExtras).ok).toBe(true);
  });

  it("负花费/负时长 → 拒绝", () => {
    const r = parseTripCheckDocument({
      specVersion: "trip-check/0.1",
      days: [
        {
          day: 1,
          spots: [{ name: "A", time: "09:00-10:00", costCny: -1, durationMin: -5 }],
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("JSON Schema 与 zod 契约同步", () => {
  it("schema 声明的必填字段与 zod 一致（specVersion/days，day.spots，spot.name/time）", () => {
    const required = TRIP_CHECK_JSON_SCHEMA.required as string[];
    expect(required).toContain("specVersion");
    expect(required).toContain("days");
    const defs = TRIP_CHECK_JSON_SCHEMA.$defs as Record<string, Record<string, unknown>>;
    expect(defs.day.required).toContain("day");
    expect(defs.day.required).toContain("spots");
    expect(defs.spot.required).toContain("name");
    expect(defs.spot.required).toContain("time");
    // zod 侧同样拒绝缺 name 的点位
    const r = TripCheckDocumentSchema.safeParse({
      specVersion: "trip-check/0.1",
      days: [{ day: 1, spots: [{ time: "09:00-10:00" }] }],
    });
    expect(r.success).toBe(false);
  });

  it("schema 的 factState/来源枚举与实现一致", () => {
    const defs = TRIP_CHECK_JSON_SCHEMA.$defs as Record<string, Record<string, unknown>>;
    expect(defs.factState.enum).toEqual(["hit", "miss", "error", "not_checked"]);
    expect(defs.source.enum).toEqual(["amap", "google_places", "osm", "manual", "mock", "other"]);
  });
});
