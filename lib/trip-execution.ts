// 行中执行状态（产品线 C2：出发提醒 + 到达打卡）
//
// 为什么需要：调研结论——北极星「照着走完率」原来的口径只是「行中打开过且没改过」，
// 这是**弱信号**（打开 ≠ 照着走）。用户在路上点「我已到达」是**强信号**：
// 他真的按这个行程走了。两个口径都在看板上给，前者保守、后者精确。
//
// 存储选 localStorage 而不是服务端：
// - 未登录用户没有账号维度（「陌生人可用」是产品前提），而打卡是高频写操作，
//   为它引入账号体系是拿大炮打蚊子；
// - 打卡数据只影响「这台设备上」的 UI 与埋点，跨设备不归并（与北极星已知局限
//   一致，登录体系补齐后再按用户归并）。
//
// 三条红线：
// 1. **只记用户主动点的**：不拿「页面打开过」冒充「到达」；
// 2. **脏数据不炸**：历史版本/手改的存储逐字段校验，坏条目丢弃；
// 3. **不猜通勤**：没有真实路段数据就不给出发建议（给「数据缺失」的说明）。

import type { PlanLeg, PlanSpot } from "./types";

// gitleaks:allow —— 这是 localStorage 键名（tp.execution.v1），不是密钥；
// gitleaks 的 generic-api-key 规则会按「= 长字符串 + 熵」误报，行内白名单精确放行。
const STORAGE_KEY = "tp.execution.v1"; // gitleaks:allow

/** 一个点位的执行状态（时间戳 ms） */
export interface SpotExecution {
  departedAt?: number;
  arrivedAt?: number;
}

/** shareId → day → spotName → 执行状态 */
export type ExecutionLog = Record<string, Record<string, Record<string, SpotExecution>>>;

function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function isExecutionLog(v: unknown): v is ExecutionLog {
  if (!v || typeof v !== "object") return false;
  for (const byDay of Object.values(v as Record<string, unknown>)) {
    if (!byDay || typeof byDay !== "object") return false;
    for (const bySpot of Object.values(byDay as Record<string, unknown>)) {
      if (!bySpot || typeof bySpot !== "object") return false;
      for (const exec of Object.values(bySpot as Record<string, unknown>)) {
        if (!exec || typeof exec !== "object") return false;
        const e = exec as Record<string, unknown>;
        if (e.departedAt !== undefined && typeof e.departedAt !== "number") return false;
        if (e.arrivedAt !== undefined && typeof e.arrivedAt !== "number") return false;
      }
    }
  }
  return true;
}

/** 读取全部打卡记录；坏数据/隐私模式 → 空对象（不影响使用） */
export function loadExecutionLog(): ExecutionLog {
  if (!hasStorage()) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isExecutionLog(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 某份行程某天的打卡记录 */
export function loadDayExecution(shareId: string, day: number): Record<string, SpotExecution> {
  return loadExecutionLog()[shareId]?.[String(day)] ?? {};
}

function writeLog(log: ExecutionLog): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    /* 隐私模式/写满：打卡只丢本地展示，不影响行程本身 */
  }
}

/** 标记「我已出发」；返回更新后的当天记录 */
export function markDeparted(
  shareId: string,
  day: number,
  spotName: string,
  at: number = Date.now(),
): Record<string, SpotExecution> {
  const log = loadExecutionLog();
  const dayKey = String(day);
  const dayExec = { ...(log[shareId]?.[dayKey] ?? {}) };
  const prev = dayExec[spotName] ?? {};
  dayExec[spotName] = { ...prev, departedAt: prev.departedAt ?? at };
  log[shareId] = { ...(log[shareId] ?? {}), [dayKey]: dayExec };
  writeLog(log);
  return dayExec;
}

/** 标记「我已到达」；同时补上出发时间（没点出发也可能到了） */
export function markArrived(
  shareId: string,
  day: number,
  spotName: string,
  at: number = Date.now(),
): Record<string, SpotExecution> {
  const log = loadExecutionLog();
  const dayKey = String(day);
  const dayExec = { ...(log[shareId]?.[dayKey] ?? {}) };
  const prev = dayExec[spotName] ?? {};
  dayExec[spotName] = {
    ...prev,
    departedAt: prev.departedAt ?? at,
    arrivedAt: prev.arrivedAt ?? at,
  };
  log[shareId] = { ...(log[shareId] ?? {}), [dayKey]: dayExec };
  writeLog(log);
  return dayExec;
}

/** 当天已到达的点位名（时间轴打勾用） */
export function arrivedSpotNames(dayExec: Record<string, SpotExecution>): string[] {
  return Object.entries(dayExec)
    .filter(([, e]) => typeof e.arrivedAt === "number")
    .map(([name]) => name);
}

// ------------------------------------------------------------
// 出发建议（纯计算）
// ------------------------------------------------------------

/** 不同交通方式的缓冲分钟数：等车/找路/过马路的现实损耗 */
// auto（智能组合）在 legs 里会落成具体方式，但类型上仍可能出现——按最保守的
// 驾车缓冲算，少算缓冲让人赶不上车比多等 5 分钟更糟。
const BUFFER_MIN: Record<PlanLeg["mode"], number> = {
  walking: 5,
  bicycling: 5,
  driving: 10,
  auto: 10,
};

export interface DepartureAdvice {
  /** 建议出发时间（"HH:MM"） */
  departAt: string;
  /** 路段耗时（分钟） */
  transitMin: number;
  /** 缓冲（分钟） */
  bufferMin: number;
  mode: PlanLeg["mode"];
}

function fmtClock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 计算「几点出发去下一站」。
 *
 * @param nowMinutes 当前本地时间（分钟，0-1439）
 * @param nextSpot   下一站（开始时间可解析）
 * @param leg        上一站 → 下一站的真实路段（没有则无法建议）
 *
 * 没有 legs 数据时返回 null——不拿估算值给建议（和「不通勤估算就不判绕路」同源）。
 */
export function departureAdvice(
  nowMinutes: number,
  nextSpot: PlanSpot,
  leg: PlanLeg | undefined,
): DepartureAdvice | null {
  if (!leg) return null;
  const start = parseStartMinutes(nextSpot.time);
  if (start === null) return null;
  const bufferMin = BUFFER_MIN[leg.mode] ?? 5;
  const transitMin = Math.max(1, Math.round(leg.durationSec / 60));
  const departAt = start - transitMin - bufferMin;
  // 已经过了建议出发时间：建议「现在就走」，不把时间倒回过去（那是假数据）
  const effective = departAt < nowMinutes ? nowMinutes : departAt;
  return { departAt: fmtClock(effective), transitMin, bufferMin, mode: leg.mode };
}

/** "09:00-11:30" → 540；解析不了返回 null（不猜） */
function parseStartMinutes(time: string): number | null {
  const m = time.match(/^(\d{2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}
