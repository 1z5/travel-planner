import "server-only";
import { AMAP_MOCK, amapGetRetry } from "./amap";
import type { Plan } from "./types";

// ============================================================
// 天气预报 → 行程天气风险提示。
//
// 产品定位：**只提示，不改写**。把「预报有雨、当天有室外景点」这个风险
// 摊开告诉用户，不擅自把景点换成 rainBackup——换不换由用户决定。
// （与项目「体检而非改写」的一贯立场一致。）
//
// 两个现实约束（都实测踩过）：
// 1. 高德预报**只有 4 天窗口**：用户规划 10 天后的行程时，超出窗口的
//    日子根本没有预报数据。此时绝不能编造天气，只能明确告知「暂查不到」。
// 2. 预报按「城市」维度，区域行程（川西环线跨 3 个行政区）只能取到
//    主城市天气，山区与小气候可能差别很大——文案要说清这是近似值。
// ============================================================

/** 需要看天气的户外活动类型（type=sight 的室外景点 + activity 的户外体验） */
const OUTDOOR_TYPES = new Set(["sight", "activity"]);

/** 判定「坏天气」：中雨及以上、雨雪、以及影响出行的恶劣天气 */
function isBadWeather(w: string): boolean {
  return /雨|雪|雹|沙|尘|雾|霾/.test(w);
}

/** 天气数据（按天） */
export interface DayWeather {
  date: string; // YYYY-MM-DD
  dayWeather: string; // 白天天气，如「小雨」
  nightWeather: string;
  dayTemp: string;
  nightTemp: string;
}

/** 天气查询结果：ok=有数据 / unavailable=查不到（超出预报窗口或上游异常） */
export type WeatherResult =
  { state: "ok"; days: DayWeather[] } | { state: "unavailable"; reason: string };

/**
 * 查城市未来天气预报。
 *
 * MOCK 模式返回 unavailable——没有高德 key 时天气功能不可用，
 * 不应假装有天气数据（调用方据此跳过天气提示，不报错）。
 */
export async function fetchWeather(city: string): Promise<WeatherResult> {
  if (AMAP_MOCK) return { state: "unavailable", reason: "未配置高德 key" };

  const r = await amapGetRetry("/v3/weather/weatherInfo", {
    city,
    extensions: "all",
  });
  if (!r.ok) return { state: "unavailable", reason: r.detail };

  const forecasts = (r.data as { forecasts?: Array<{ casts?: Array<Record<string, string>> }> })
    ?.forecasts;
  const casts = forecasts?.[0]?.casts;
  if (!casts?.length) return { state: "unavailable", reason: "预报无数据" };

  const days: DayWeather[] = casts.map((c) => ({
    date: String(c.date ?? ""),
    dayWeather: String(c.dayweather ?? ""),
    nightWeather: String(c.nightweather ?? ""),
    dayTemp: String(c.daytemp ?? ""),
    nightTemp: String(c.nighttemp ?? ""),
  }));
  return { state: "ok", days };
}

/** 天气提示的生成结果 */
export interface WeatherAdvice {
  /** 要追加到 plan.warnings 的提示（已格式化，直接可用） */
  warnings: string[];
  /** 有预报覆盖的天数（用于文案说明覆盖范围） */
  coveredDays: number;
}

/**
 * 为行程生成天气风险提示。
 *
 * 逻辑：把行程每天与预报按日期对齐——
 * - 白天或夜间天气「坏」且当天有室外景点 → 提示「建议参考各景点的雨天备选」
 * - 预报窗口未覆盖的天 → 不猜，明确告知「暂查不到」
 *
 * 只读不改：完全不碰 plan.days 的内容，只在 warnings 里加提示。
 */
export async function buildWeatherAdvice(
  plan: Plan,
  weather: WeatherResult,
): Promise<WeatherAdvice> {
  if (weather.state !== "ok") {
    return { warnings: [], coveredDays: 0 };
  }

  const byDate = new Map(weather.days.map((d) => [d.date, d]));
  const warnings: string[] = [];
  let coveredDays = 0;

  for (const [dayIdx, day] of plan.days.entries()) {
    // 行程第 N 天对应的日期：startDate + (N-1)
    if (!plan.startDate) break;
    const date = addDays(plan.startDate, dayIdx);
    const w = byDate.get(date);
    if (!w) continue; // 超出预报窗口：不猜天气
    coveredDays += 1;

    const outdoor = day.spots.filter((s) => OUTDOOR_TYPES.has(s.type));
    if (!outdoor.length) continue;

    const badDay = isBadWeather(w.dayWeather);
    const badNight = isBadWeather(w.nightWeather);
    if (!badDay && !badNight) continue;

    const when = badDay && badNight ? "全天" : badDay ? "白天" : "夜间";
    const names = outdoor
      .slice(0, 3)
      .map((s) => s.name)
      .join("、");
    const more = outdoor.length > 3 ? " 等" : "";
    const withBackup = outdoor.filter((s) => s.rainBackup).length;
    const backupHint = withBackup
      ? `其中 ${withBackup} 个已备有雨天备选，可直接参考`
      : "这些景点未备雨天备选，建议提前查室内替代";
    warnings.push(
      `第 ${day.day} 天（${date}）${when}预报「${badDay ? w.dayWeather : w.nightWeather}」，当天有 ${outdoor.length} 个室外景点（${names}${more}）。${backupHint}`,
    );
  }

  return { warnings, coveredDays };
}

/** "YYYY-MM-DD" + n 天 → "YYYY-MM-DD"（用 UTC 算术避免时区漂移） */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
