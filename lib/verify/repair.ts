// ============================================================
// Trip Check Repair：确定性修复器（判定 → 可执行 → 重验 → 前后凭据）
//
// 为什么需要（2026-10 调研的最强空白）：356 份真实 AI 行程里 43% 的行程日至少含
// 一个可验证错误（提前到场/超闭馆/闭馆日/绕路），但竞品都只提醒不修；产品内已有
// 「一键修复」，却只服务自家行程。开放核验层如果只判不修，第三方拿到报告仍然要
// 手改——把「评分 + 证据 + 修复 + 重验」补成闭环，并用修复前后两张凭据把
// 「改了什么、风险降了多少」变成可对账的事实。
//
// 铁律（与项目「不猜、不假装」同源）：
// 1) **只做有数据依据、不改变语义的机械变换**：
//    - retime：把被顺延的点位时间整体后移（消除时间重叠 / 路段接不上）；
//    - dedupe：删除同一天重复的同名点位（保留第一条）。
// 2) **不编造任何事实**：不加地点、不改营业时间、不补路段耗时、不删独立点位、
//    不替用户做「换哪一天/删哪个点」的取舍。
// 3) **修不了就说修不了**：缺数据、超 24:00 边界、预算/节奏/分散等需要取舍的问题，
//    逐条写进 unrepairable，并给下一步指引；绝不悄悄改掉。
// 4) **可复现**：纯函数；同一输入 + 同一口径 → 同一修复结果（时间只由入参 now 注入
//    给前后报告，不参与任何判定/修复逻辑）。
//
// 与 engine 的关系：修复只改文档，判定仍由 verifyDocument 做（before/after 同一套
// 规则、同一个 now）。这样「修复后变好了」不是自证，而是同一把尺子量的。
// ============================================================

import { parseTimeRange } from "../schedule";
import { verifyDocument } from "./engine";
import { RULES } from "./rules";
import {
  type DocDay,
  type DocLeg,
  type DocSpot,
  type RepairApplied,
  type RepairResult,
  type RepairUnrepairable,
  type TripCheckDocument,
  type TripCheckOptions,
} from "./types";

/** 机械修复能消除的规则（与 rules.ts 的 mechanicalFix 对应） */
const MECHANICAL_RULE_IDS = new Set(["TC-C102", "TC-C103", "TC-C109"]);

/** 非机械修复的规则 → 为什么修不了（给用户/agent 的下一步指引） */
const UNREPAIRABLE_REASON: Record<string, string> = {
  "TC-C101": "时间格式非法，修复器不知道正确时刻是几点，不猜。",
  "TC-C102": "顺延后仍无法消除重叠（可能是当天 24:00 边界或时间数据自相矛盾），需人工调整。",
  "TC-C103": "顺延后仍无法满足路段耗时（可能是 24:00 边界），需人工调整或换点。",
  "TC-C104": "缺少真实路段耗时，修复器不能编造通勤时间。",
  "TC-C105": "缺少停留时长/花费，修复器不按 0 补齐。",
  "TC-C106": "当天通勤偏长，需要换点/拆天（涉及内容取舍，修复器不做）。",
  "TC-C107": "节奏偏满，需要删点或改时长（涉及取舍，修复器不做）。",
  "TC-C108": "超出预算，需要换项目或调预算（涉及取舍，修复器不做）。",
  "TC-C109": "去重后仍有重复点位（同名但格式不同），需人工确认。",
  "TC-C110": "空白天需要补内容，修复器不生成行程内容。",
  "TC-C111": "点位分散，需要换点/拆天（涉及取舍，修复器不做）。",
  "TC-F201": "地点未核验，需要补事实来源或换点；修复器不编造事实。",
  "TC-F202": "地点在事实源中未命中，需要换点或核对名称；修复器不编造地点。",
  "TC-F203": "营业时间不可用，需要补来源数据；修复器不猜营业时间。",
  "TC-F204": "营业时间对不上，需要换天/换时段（涉及取舍），修复器不改日期。",
  "TC-F205": "事实源查询失败，需要稍后重试；修复器不把「不知道」改成「没问题」。",
};

function cloneDocument(doc: TripCheckDocument): TripCheckDocument {
  // 开放文档是纯 JSON（见 schema.ts），JSON 往返是最稳的深拷贝；
  // structuredClone 在浏览器可用但 Node 老版本/边缘运行时不一定有。
  return JSON.parse(JSON.stringify(doc)) as TripCheckDocument;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtClock(min: number): string {
  return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function fmtRange(start: number, end: number): string {
  return `${fmtClock(start)}-${fmtClock(end)}`;
}

/** 按 from/to 名称找路段（重复以第一条为准，与 engine/schedule 同口径） */
function findLeg(legs: DocLeg[] | undefined, from: string, to: string): DocLeg | undefined {
  return legs?.find((l) => l.from === from && l.to === to);
}

/** 路段耗时（分钟，向上取整）；缺失/非法 → null（不按 0 分钟假设可接上） */
function legMinutes(leg: DocLeg | undefined): number | null {
  if (!leg || typeof leg.durationMin !== "number" || !Number.isFinite(leg.durationMin)) return null;
  if (leg.durationMin < 0) return null;
  return Math.ceil(leg.durationMin);
}

interface DayRepairOutcome {
  applied: RepairApplied[];
  unrepairable: RepairUnrepairable[];
}

/**
 * 删除同一天重复的同名点位（保留第一条）。
 *
 * 返回值带 keptIndexes：kept 里每个点在**原始 spots 数组**中的下标。
 * 后续 retime 的 RepairApplied.spotIndex 必须用原始下标，产品侧才能把变更
 * 套回内部 Plan（Plan 的 spot 还有 period/reason/rainBackup 等文档字段外的属性）。
 */
function dedupeDay(day: DocDay): { applied: RepairApplied[]; keptIndexes: number[] } {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const seen = new Set<string>();
  const kept: DocSpot[] = [];
  const keptIndexes: number[] = [];
  const applied: RepairApplied[] = [];
  spots.forEach((spot, index) => {
    const key = spot.name.trim();
    if (seen.has(key)) {
      applied.push({
        ruleId: "TC-C109",
        day: day.day,
        spot: spot.name,
        spotIndex: index,
        detail: `删除第 ${day.day} 天重复点位「${spot.name}」（保留第一次出现的那条）`,
      });
      return;
    }
    seen.add(key);
    kept.push(spot);
    keptIndexes.push(index);
  });
  day.spots = kept;
  return { applied, keptIndexes };
}

/**
 * 顺延当天时间轴：消除相邻点位的「时间重叠」与「路段接不上」。
 *
 * 算法（贪心、只后移不提前）：保持第一个点不变；对每个后续点，
 * 最早可开始 = 上一点结束 + 该段真实耗时（没有路段数据时按 0 计——只能消重叠，
 * 不能证明可达，这一点由引擎的 TC-C104 如实说出）。若会超过当天 24:00，
 * 整天的顺延回滚（不做局部半截修复，避免产生自相矛盾的文档）。
 */
function retimeDay(day: DocDay, originalIndexes: number[]): DayRepairOutcome {
  const spots = Array.isArray(day.spots) ? day.spots : [];
  const outcome: DayRepairOutcome = { applied: [], unrepairable: [] };
  if (spots.length < 2) return outcome;

  const ranges = spots.map((s) => parseTimeRange(s.time));
  if (ranges.some((r) => r === null)) {
    outcome.unrepairable.push({
      ruleId: "TC-C101",
      day: day.day,
      reason: UNREPAIRABLE_REASON["TC-C101"],
    });
    return outcome;
  }
  const original = ranges as Array<{ start: number; end: number }>;

  // 先规划（不落盘）：start/end 均可能被后移；记录每个点的「触发规则」
  const planned = original.map((r) => ({ start: r.start, end: r.end }));
  const causes: Array<"TC-C102" | "TC-C103" | null> = original.map(() => null);
  let lastCause: "TC-C102" | "TC-C103" | null = null;
  for (let i = 1; i < spots.length; i += 1) {
    const leg = findLeg(day.legs, spots[i - 1].name, spots[i].name);
    const legMin = legMinutes(leg);
    const prevEnd = planned[i - 1].end;
    // 原始相邻关系用于归因（是重叠还是接不上）
    const originalGap = original[i].start - original[i - 1].end;
    let cause: "TC-C102" | "TC-C103" | null = null;
    if (originalGap < 0) cause = "TC-C102";
    else if (legMin !== null && originalGap < legMin) cause = "TC-C103";
    if (cause) lastCause = cause;

    // 重叠 → 至少从上一站结束时开始；有真实路段 → 必须留足耗时
    const earliest = Math.max(prevEnd, legMin === null ? prevEnd : prevEnd + legMin);
    if (planned[i].start < earliest) {
      const delta = earliest - planned[i].start;
      planned[i].start += delta;
      planned[i].end += delta;
      causes[i] = cause ?? lastCause ?? "TC-C103";
    }
  }

  // 24:00 边界：整天的顺延回滚（不做半截修复）
  const overflowIndex = planned.findIndex((p) => p.end > 1440);
  if (overflowIndex !== -1) {
    outcome.unrepairable.push({
      ruleId: causes[overflowIndex] ?? "TC-C103",
      day: day.day,
      spot: spots[overflowIndex].name,
      reason: "顺延后会超过当天 24:00，无法在不删点/不改内容的前提下修复。",
    });
    return outcome;
  }

  // 落盘：只改时间真的变了的点
  for (let i = 0; i < spots.length; i += 1) {
    const before = spots[i].time;
    const after = fmtRange(planned[i].start, planned[i].end);
    if (before === after) continue;
    spots[i].time = after;
    outcome.applied.push({
      ruleId: causes[i] ?? "TC-C103",
      day: day.day,
      spot: spots[i].name,
      spotIndex: originalIndexes[i],
      from: before,
      to: after,
      detail: `第 ${day.day} 天「${spots[i].name}」时间 ${before} → ${after}（顺延 ${planned[i].start - original[i].start} 分钟，消除${causes[i] === "TC-C102" ? "重叠" : "时间接不上"}）`,
    });
  }
  return outcome;
}

/**
 * 确定性修复一份开放行程文档。
 *
 * @param doc     待修复文档（不修改入参）
 * @param options 判定口径（before/after 用同一口径，否则前后不可比）
 * @param now     注入时间（只用于两份报告的 checkedAt；不参与修复逻辑）
 */
export function repairDocument(
  doc: TripCheckDocument,
  options: TripCheckOptions = {},
  now: Date = new Date(),
): RepairResult {
  // before 必须在克隆之前算（引擎不改入参，但语义上「修复前」= 原始文档）
  const before = verifyDocument(doc, options, now);
  const repaired = cloneDocument(doc);
  const applied: RepairApplied[] = [];
  const unrepairable: RepairUnrepairable[] = [];

  for (const day of repaired.days ?? []) {
    // 1) 去重（先做，避免重复点参与后续时间轴规划）；返回原始下标映射
    const dedupe = dedupeDay(day);
    applied.push(...dedupe.applied);
    // 2) 顺延时间轴（用原始下标标注变更，产品侧才能套回 Plan）
    const outcome = retimeDay(day, dedupe.keptIndexes);
    applied.push(...outcome.applied);
    unrepairable.push(...outcome.unrepairable);
  }

  // 3) 用同一套引擎重验（修复后变没变好，不由修复器自己说）
  const after = verifyDocument(repaired, options, now);

  // 4) 如实列出修不了的问题（按 rule/day/spot 去重，避免逐点刷屏）
  const seen = new Set<string>();
  for (const issue of after.issues) {
    if (MECHANICAL_RULE_IDS.has(issue.ruleId)) {
      // 机械规则仍有残留（正常路径下应被修复掉）：说明是 24:00 边界/数据矛盾，需人工
      const key = `${issue.ruleId}:${issue.evidence.day ?? 0}:${issue.evidence.spot ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unrepairable.push({
        ruleId: issue.ruleId,
        ...(issue.evidence.day ? { day: issue.evidence.day } : {}),
        ...(issue.evidence.spot ? { spot: issue.evidence.spot } : {}),
        reason: UNREPAIRABLE_REASON[issue.ruleId] ?? "修复器无法在不编造数据的前提下修复。",
      });
      continue;
    }
    if (MECHANICAL_RULE_IDS.has(issue.ruleId)) continue; // 本来就不需要修
    const key = `${issue.ruleId}:${issue.evidence.day ?? 0}:${issue.evidence.spot ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unrepairable.push({
      ruleId: issue.ruleId,
      ...(issue.evidence.day ? { day: issue.evidence.day } : {}),
      ...(issue.evidence.spot ? { spot: issue.evidence.spot } : {}),
      reason: UNREPAIRABLE_REASON[issue.ruleId] ?? RULES[issue.ruleId]?.fixHint ?? "需人工处理。",
    });
  }

  const gradeRank = { A: 4, B: 3, C: 2, D: 1 } as const;
  const blockingReduced = before.stats.blocking - after.stats.blocking;
  const improved =
    after.verdict.consistency.score > before.verdict.consistency.score ||
    blockingReduced > 0 ||
    gradeRank[after.verdict.consistency.grade] > gradeRank[before.verdict.consistency.grade];

  return {
    document: repaired,
    applied,
    remainingRuleIds: [...new Set(after.issues.map((i) => i.ruleId))].sort(),
    unrepairable,
    before,
    after,
    delta: {
      score: after.verdict.consistency.score - before.verdict.consistency.score,
      gradeFrom: before.verdict.consistency.grade,
      gradeTo: after.verdict.consistency.grade,
      blockingReduced,
      improved,
    },
  };
}
