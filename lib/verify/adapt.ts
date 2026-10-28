// ============================================================
// 内部 Plan → 开放 Trip Check 文档的适配层（纯函数，client-safe）
//
// 为什么需要适配而不是直接暴露 Plan：
// 1) 开放标准不能依赖本项目的内部字段（LLM 生成痕迹、UI 专用结构）；对方
//    只需要「点了什么、几点到几点、花费多少、这条事实是谁核的」。
// 2) 内部 Plan 里有 rich 字段（poi/legs/warnings），适配时**只搬事实、不搬猜测**：
//    有坐标/有营业时间原文才标 hit；MOCK/未核验一律 not_checked。
// 3) 适配结果要能被 engine 独立复算——不读取当前时间、不读环境变量。
//
// 三态映射规则（诚实优先，宁可少说）：
// - location 存在 → existence=hit（验真命中才会回填坐标）
// - 验真完成（verification=ok）且类型可验 → 坐标缺失视为 miss；否则 not_checked
// - 有营业时间原文 → hours=hit；验真 ok 但来源没给 → miss（查询过、源没有）
// - verification=partial（上游波动）→ 不给 hit，避免把「没核完」说成核过
// ============================================================

import type { Plan } from "../types";
import {
  TRIP_CHECK_SPEC_VERSION,
  type DocDay,
  type DocLeg,
  type DocProvenance,
  type DocSpot,
  type FactState,
  type TripCheckDocument,
  type VerifySource,
} from "./types";

/** 可以验真的点位类型（与 validate.ts 的 GEO_TYPES 同口径；transport 是移动描述不是 POI） */
const VERIFIABLE_TYPES = new Set(["sight", "food", "activity", "hotel"]);

/** "YYYY-MM-DD" + 偏移天数 → "YYYY-MM-DD"；非法输入返回 undefined（不猜日期） */
export function addDaysIso(iso: string | undefined, offset: number): string | undefined {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return undefined;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return undefined;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

export interface AdaptPlanOptions {
  /** 文档 id（分享 token 等外部标识；不传就不写） */
  id?: string;
}

/**
 * 把内部 Plan 转成开放文档。
 *
 * 注意：适配只做「搬运 + 三态映射」，不做任何判定；判定全部交给 engine.ts，
 * 这样自家行程与第三方行程走的是同一套规则（否则开放标准就是假的）。
 */
export function planToDocument(plan: Plan, options: AdaptPlanOptions = {}): TripCheckDocument {
  const verification = plan.verification;
  const source: VerifySource | undefined =
    verification === "mock"
      ? "mock"
      : verification === "ok"
        ? "amap"
        : verification === "partial"
          ? "amap"
          : plan.verified
            ? "amap"
            : undefined;
  // partial 表示「有上游波动、没核完」：不能把剩下的点标成 hit/miss
  const fullyVerified = verification === "ok" && plan.verified === true;
  const checkedAtIso =
    typeof plan.verifiedAt === "number" && Number.isFinite(plan.verifiedAt)
      ? new Date(plan.verifiedAt).toISOString()
      : undefined;

  const days: DocDay[] = (Array.isArray(plan.days) ? plan.days : []).map((day) => {
    const spots: DocSpot[] = (Array.isArray(day.spots) ? day.spots : []).map((spot) => {
      const verifiable = VERIFIABLE_TYPES.has(spot.type);
      const missWarned = (plan.warnings ?? []).some((w) =>
        w.includes(`「${spot.name}」未在高德检索到`),
      );
      const hasHoursText = Boolean(
        spot.poi?.openTime || spot.poi?.openTime2 || spot.poi?.temporarilyClosed,
      );

      const existence: FactState = spot.location
        ? "hit"
        : missWarned
          ? "miss"
          : fullyVerified && verifiable
            ? "miss"
            : "not_checked";
      const hours: FactState = hasHoursText
        ? "hit"
        : fullyVerified && verifiable
          ? "miss"
          : "not_checked";

      return {
        name: spot.name,
        time: spot.time,
        ...(spot.type ? { type: spot.type } : {}),
        ...(typeof spot.durationMin === "number" ? { durationMin: spot.durationMin } : {}),
        ...(typeof spot.costCny === "number" ? { costCny: spot.costCny } : {}),
        ...(spot.area ? { area: spot.area } : {}),
        ...(spot.location ? { location: spot.location } : {}),
        ...(hasHoursText && spot.poi
          ? {
              hours: {
                ...(spot.poi.openTime ? { openTime: spot.poi.openTime } : {}),
                ...(spot.poi.openTime2 ? { openTime2: spot.poi.openTime2 } : {}),
                ...(spot.poi.temporarilyClosed ? { temporarilyClosed: true } : {}),
              },
            }
          : {}),
        verification: {
          ...(source ? { source } : {}),
          existence,
          hours,
          ...(checkedAtIso ? { checkedAt: checkedAtIso } : {}),
        },
      };
    });

    const legs: DocLeg[] | undefined = Array.isArray(day.legs)
      ? day.legs
          .filter((l) => Number.isFinite(l.durationSec))
          .map((l) => ({
            from: l.from,
            to: l.to,
            mode: l.mode,
            durationMin: Math.ceil(l.durationSec / 60),
            ...(Number.isFinite(l.distanceM) ? { distanceM: l.distanceM } : {}),
            ...(source ? { source } : {}),
            state: source ? "hit" : "not_checked",
          }))
      : undefined;
    // 一段都没算出来就不写 legs（与 Plan 的语义一致：没有 ≠ 空数组）
    const legsOut = legs && legs.length > 0 ? legs : undefined;

    const date = addDaysIso(plan.startDate, day.day - 1);
    return {
      day: day.day,
      ...(date ? { date } : {}),
      ...(day.city ? { city: day.city } : {}),
      spots,
      ...(legsOut ? { legs: legsOut } : {}),
    };
  });

  const hasLegs = days.some((d) => (d.legs?.length ?? 0) > 0);
  const provenance: DocProvenance | undefined = source
    ? {
        poi: { source, ...(checkedAtIso ? { checkedAt: checkedAtIso } : {}) },
        hours: { source, ...(checkedAtIso ? { checkedAt: checkedAtIso } : {}) },
        ...(hasLegs
          ? { routes: { source, ...(checkedAtIso ? { checkedAt: checkedAtIso } : {}) } }
          : {}),
      }
    : undefined;

  return {
    specVersion: TRIP_CHECK_SPEC_VERSION,
    ...(options.id ? { id: options.id } : {}),
    ...(plan.city ? { city: plan.city } : {}),
    days,
    ...(typeof plan.budgetCny === "number" ? { budgetCny: plan.budgetCny } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
