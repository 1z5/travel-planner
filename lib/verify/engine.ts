// ============================================================
// Trip Check 判定引擎（确定性 · 纯函数 · 可在浏览器/Node/测试里跑同一份规则）
//
// 输入是一份「开放行程文档」（Trip Check v0.1），输出是一份可对账报告：
// 结构自洽性（A/B/C/D）+ 事实核验覆盖（verified/partial/unverified）+ 规则级证据。
//
// 为什么必须是确定性纯函数（三条红线，与项目既有原则同源）：
// 1) **可复算**：开放标准的价值在「任何一方都能独立重跑同一结论」。调模型、
//    带随机性、依赖当前时间/网络都会让报告不可复现——凭据 ID 也就失去意义。
//    时间只作为 `now` 参数注入（生成 checkedAt），不参与任何判定。
// 2) **不猜**：缺数据就说缺（TC-C104/C105、facts 覆盖率），绝不按 0 分钟/
//    0 花费补齐后假装判过；事实源 unknown 不判闭馆、error 不当「不存在」。
// 3) **不自动改**：引擎只判定，fixHint 只给方向。改行程是产品另一条路径，
//    核验层不能既当裁判又当运动员。
//
// 两轴分开（见 types.ts 的设计取舍）：
// - consistency 分数只由「结构问题」扣分（时间轴/节奏/预算/重复/空天）；
// - facts 不折成分数，用覆盖 + 三态表达；位置点是否真实、开门时间是否对上，
//   取决于文档声明的来源，不能用一个总分掩盖「没核验」。
// ============================================================

import { checkOpenHours } from "../poi-hours";
import { parseTimeRange } from "../schedule";
import { RULE_IDS, RULES, SEVERITY_WEIGHT } from "./rules";
import {
  TRIP_CHECK_ENGINE_NAME,
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type ConsistencyVerdict,
  type DocDay,
  type DocLeg,
  type DocSpot,
  type FactsVerdict,
  type IssueCategory,
  type IssueEvidence,
  type IssueSeverity,
  type OverallStatus,
  type TripCheckDocument,
  type TripCheckOptions,
  type TripCheckReport,
  type VerifyIssue,
  type VerifySource,
} from "./types";

// 阈值与产品内体检保持同一口径（lib/validate.ts）。故意复制常量而不是 import
// validate.ts：validate 依赖高德/服务器侧链路，而本引擎必须 client-safe。
// 口径漂移由 tests/lib/verify/engine.test.ts 的边界用例守住（阈值变化必须显式改）。
const TRANSIT_WARN_MIN = 120; // 当天通勤合计超过 2 小时 → 疑似绕路
const BUDGET_OVER = 1.05; // 超预算 5% 才告警（与产品内一致）
const AREA_SPREAD_WARN = 4; // 当天景点跨 4 个以上区域 → 分散提示
const PACE_DAY_MIN: Record<NonNullable<TripCheckOptions["pace"]>, number> = {
  relaxed: 8 * 60,
  balanced: 10 * 60,
  packed: 13 * 60,
};
const PACE_LABEL: Record<NonNullable<TripCheckOptions["pace"]>, string> = {
  relaxed: "轻松",
  balanced: "适中",
  packed: "紧凑",
};
const GRADE_LABEL = {
  A: "可执行",
  B: "基本可执行",
  C: "需微调",
  D: "待优化",
} as const;
/** 同一条规则最多扣 3 次分：10 条重复问题不该把分数扣穿，但也不能当没看见 */
const PENALTY_MAX_HITS = 3;

// ---------- 小工具（全部纯函数） ----------

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h <= 0) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

function fmtClock(min: number): string {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 合法日历日期（格式 + round-trip；与 validate.isRealDate 同口径，但不引 server 链路） */
export function isRealDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 10) === s;
}

function findLeg(legs: DocLeg[] | undefined, from: string, to: string): DocLeg | undefined {
  if (!legs?.length) return undefined;
  // 重复同名段以第一条为准（与 schedule.checkDaySchedule 同口径）
  return legs.find((l) => l.from === from && l.to === to);
}

/** 路段耗时（分钟，向上取整到整分钟）；非法/缺失 → null（不按 0 分钟算） */
function legMinutes(leg: DocLeg | undefined): number | null {
  if (!leg || typeof leg.durationMin !== "number" || !Number.isFinite(leg.durationMin)) return null;
  if (leg.durationMin < 0) return null;
  return Math.ceil(leg.durationMin);
}

/** 停留时长（分钟）；非法/缺失 → null */
function spotDuration(spot: DocSpot): number | null {
  if (typeof spot.durationMin !== "number" || !Number.isFinite(spot.durationMin)) return null;
  if (spot.durationMin <= 0) return null;
  return spot.durationMin;
}

/** 花费（人民币元）；非法/缺失 → null */
function spotCost(spot: DocSpot): number | null {
  if (typeof spot.costCny !== "number" || !Number.isFinite(spot.costCny)) return null;
  if (spot.costCny < 0) return null;
  return spot.costCny;
}

/** 有效营业时间原文：至少有一个可交给 poi-hours 解析的字段 */
function hoursInput(
  spot: DocSpot,
): { openTime?: string; openTime2?: string; temporarilyClosed?: boolean } | null {
  const h = spot.hours;
  if (!h) return null;
  const openTime = typeof h.openTime === "string" && h.openTime.trim() ? h.openTime : undefined;
  const openTime2 = typeof h.openTime2 === "string" && h.openTime2.trim() ? h.openTime2 : undefined;
  const temporarilyClosed = h.temporarilyClosed === true ? true : undefined;
  if (!openTime && !openTime2 && !temporarilyClosed) return null;
  return { openTime, openTime2, temporarilyClosed };
}

function gradeOf(score: number): "A" | "B" | "C" | "D" {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  return "D";
}

function severityCount(issues: VerifyIssue[], severity: IssueSeverity): number {
  return issues.filter((i) => i.severity === severity).length;
}

function topTitles(issues: VerifyIssue[], max = 2): string {
  return issues
    .filter((i) => i.severity === "blocking")
    .slice(0, max)
    .map((i) => i.title)
    .join("、");
}

// ---------- 引擎主体 ----------

/**
 * 核验一份开放行程文档。
 *
 * @param doc     开放文档（不修改入参；不做长度上限校验——那是 API 层职责）
 * @param options 判定口径（节奏；会被写进凭据输入哈希，换口径结论可以不同）
 * @param now     注入当前时间（只用于 checkedAt；不参与判定，保证可复现）
 */
export function verifyDocument(
  doc: TripCheckDocument,
  options: TripCheckOptions = {},
  now: Date = new Date(),
): TripCheckReport {
  const pace = options.pace ?? "balanced";
  const issues: VerifyIssue[] = [];
  const days: DocDay[] = Array.isArray(doc.days) ? doc.days : [];
  const allSpots: Array<{ day: DocDay; spot: DocSpot }> = [];
  for (const day of days) {
    for (const spot of day.spots ?? []) allSpots.push({ day, spot });
  }

  const add = (
    ruleId: string,
    detail: string,
    evidence: IssueEvidence = {},
    category: IssueCategory = RULES[ruleId]?.category ?? "consistency",
    severity: IssueSeverity = RULES[ruleId]?.severity ?? "info",
  ) => {
    const meta = RULES[ruleId];
    if (!meta) return; // 规则 ID 必须在注册表里：宁可少报，不悄悄改变口径
    issues.push({
      ruleId,
      category,
      severity,
      title: meta.title,
      detail,
      evidence,
      ...(meta.fixHint ? { fixHint: meta.fixHint } : {}),
    });
  };

  // ============================================================
  // 1) 结构自洽性：只靠文档自身可判的问题
  // ============================================================
  for (const day of days) {
    const dayNo = day.day;
    const spots = Array.isArray(day.spots) ? day.spots : [];
    if (spots.length === 0) {
      add("TC-C110", `第 ${dayNo} 天没有任何点位。`, { day: dayNo });
    }

    // 1a) 时间格式 + 相邻点的时间关系（重叠 / 接不上）
    const ranges = spots.map((s) => parseTimeRange(s.time));
    ranges.forEach((range, i) => {
      if (range) return;
      add(
        "TC-C101",
        `第 ${dayNo} 天「${spots[i].name}」的时间「${spots[i].time}」无法解析，这一天的时间轴不能判定。`,
        { day: dayNo, spot: spots[i].name, raw: spots[i].time, field: "time" },
      );
    });

    let transitTotal = 0;
    let checkedPairs = 0;
    let totalPairs = 0;
    for (let i = 0; i < spots.length - 1; i += 1) {
      const cur = spots[i];
      const next = spots[i + 1];
      totalPairs += 1;
      const a = ranges[i];
      const b = ranges[i + 1];
      if (!a || !b) continue; // 时间判不了：错在格式，由 C101 负责，不在这里报假冲突

      const gapMin = b.start - a.end;
      const leg = findLeg(day.legs, cur.name, next.name);
      const needMin = legMinutes(leg);
      if (needMin !== null) {
        checkedPairs += 1;
        transitTotal += needMin;
      }

      if (gapMin < 0) {
        // 时间重叠：与有没有路段数据无关，按文档时刻物理上就不可能
        add(
          "TC-C102",
          `第 ${dayNo} 天「${cur.name}」(${cur.time}) 与「${next.name}」(${next.time}) 时间重叠 ${Math.abs(gapMin)} 分钟。`,
          {
            day: dayNo,
            from: cur.name,
            to: next.name,
            gapMinutes: gapMin,
            minutes: Math.abs(gapMin),
          },
        );
        continue;
      }
      if (needMin !== null && gapMin < needMin) {
        add(
          "TC-C103",
          `第 ${dayNo} 天「${cur.name}」${fmtClock(a.end)} 结束，到「${next.name}」${fmtClock(b.start)} 开始只有 ${gapMin} 分钟，但这段路需要 ${needMin} 分钟（${leg?.mode ?? "未标注方式"}）。`,
          {
            day: dayNo,
            from: cur.name,
            to: next.name,
            gapMinutes: gapMin,
            needMinutes: needMin,
            minutes: gapMin,
          },
        );
      }
    }
    // 1b) 缺数据：如实说「判不了」，不是通过
    const missingPairs = totalPairs - checkedPairs;
    if (totalPairs > 0 && missingPairs > 0) {
      add(
        "TC-C104",
        `第 ${dayNo} 天有 ${missingPairs}/${totalPairs} 段相邻点位缺少真实路段耗时——「时间接不接得上」这一段无法判断。`,
        { day: dayNo, count: missingPairs },
      );
    }

    const missingDuration = spots.filter((s) => spotDuration(s) === null).length;
    const missingCost = spots.filter((s) => spotCost(s) === null).length;
    if (missingDuration > 0 || missingCost > 0) {
      const fields: string[] = [];
      if (missingDuration > 0) fields.push(`${missingDuration} 个点位缺停留时长`);
      if (missingCost > 0) fields.push(`${missingCost} 个点位缺花费`);
      add(
        "TC-C105",
        `第 ${dayNo} 天${fields.join("、")}，节奏/预算判定已跳过对应部分（不用 0 补齐）。`,
        {
          day: dayNo,
          field: missingDuration > 0 ? "durationMin" : "costCny",
          count: Math.max(missingDuration, missingCost),
        },
      );
    }

    // 1c) 当天通勤总量
    if (transitTotal > TRANSIT_WARN_MIN) {
      add(
        "TC-C106",
        `第 ${dayNo} 天点位间真实通勤合计约 ${fmtMinutes(transitTotal)}，偏长，常见原因是跨区或折返。`,
        { day: dayNo, minutes: transitTotal },
      );
    }

    // 1d) 节奏：只在「停留时长齐全」时判；缺路段数据则按 0 通勤会低估，不判
    if (spots.length > 0 && missingDuration === 0 && missingPairs === 0) {
      const active = spots.reduce((sum, s) => sum + (spotDuration(s) ?? 0), 0) + transitTotal;
      const limit = PACE_DAY_MIN[pace];
      if (active > limit) {
        add(
          "TC-C107",
          `第 ${dayNo} 天净游玩约 ${fmtMinutes(active)}，超过「${PACE_LABEL[pace]}」节奏上限 ${fmtMinutes(limit)}。`,
          { day: dayNo, minutes: active, limitMinutes: limit },
        );
      }
    }

    // 1e) 当天景点分散（只在没有路段数据可证通勤可行时提示，避免与 C106 噪声叠加）
    if (missingPairs > 0) {
      const sights = spots.filter((s) => s.type === "sight");
      const regions = new Set(
        sights
          .map((s) => (typeof s.area === "string" ? s.area.trim() : ""))
          .filter((a) => a.length > 0),
      );
      if (regions.size >= AREA_SPREAD_WARN) {
        add(
          "TC-C111",
          `第 ${dayNo} 天的 ${sights.length} 个景点分布在 ${regions.size} 个不同区域（${[...regions].join("、")}），且缺少路段数据证明通勤可行。`,
          { day: dayNo, count: regions.size, names: [...regions] },
        );
      }
    }

    // 1f) 同一天重复点位
    const nameCount = new Map<string, number>();
    for (const s of spots) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1);
    const duplicates = [...nameCount.entries()].filter(([, n]) => n > 1).map(([name]) => name);
    if (duplicates.length > 0) {
      add("TC-C109", `第 ${dayNo} 天有重复点位：${duplicates.join("、")}（同名出现多次）。`, {
        day: dayNo,
        names: duplicates,
        count: duplicates.length,
      });
    }
  }

  // 1g) 预算：全文档花费齐全才判（缺数据的部分已在 C105 摊开）
  if (allSpots.length > 0 && allSpots.every(({ spot }) => spotCost(spot) !== null)) {
    const totalCost = allSpots.reduce((sum, { spot }) => sum + (spotCost(spot) ?? 0), 0);
    const budget =
      typeof doc.budgetCny === "number" && Number.isFinite(doc.budgetCny) ? doc.budgetCny : null;
    if (budget !== null && budget > 0 && totalCost > budget * BUDGET_OVER) {
      add(
        "TC-C108",
        `全行程人均花费约 ¥${Math.round(totalCost)}，超出预算 ¥${Math.round(budget)} 的 5% 弹性线。`,
        { amountCny: Math.round(totalCost), budgetCny: Math.round(budget) },
      );
    }
  }

  // ============================================================
  // 2) 事实核验：地点存在性 / 营业时间 / 路段来源
  // ============================================================
  const poiSpots = allSpots.map(({ spot }) => spot).filter((s) => s.type !== "transport");
  const counts = {
    poiTotal: poiSpots.length,
    poiChecked: 0,
    poiHit: 0,
    poiMiss: 0,
    poiError: 0,
    poiNotChecked: 0,
    hoursChecked: 0,
    hoursMiss: 0,
    hoursError: 0,
    hoursNotChecked: 0,
    routesTotal: 0,
    routesChecked: 0,
    routesError: 0,
  };
  const unverifiedNames: string[] = [];
  const hoursUnverified = { count: 0, names: [] as string[] };
  const sourceErrors: string[] = [];
  const sourceCounts: Partial<Record<VerifySource, number>> = {};

  for (const { day, spot } of allSpots) {
    if (spot.type !== "transport") {
      const v = spot.verification ?? {};
      const source = v.source ?? doc.provenance?.poi?.source;
      if (source) sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
      const existence = v.existence ?? "not_checked";
      if (existence === "hit") {
        counts.poiChecked += 1;
        counts.poiHit += 1;
      } else if (existence === "miss") {
        counts.poiChecked += 1;
        counts.poiMiss += 1;
        add(
          "TC-F202",
          `第 ${day.day} 天「${spot.name}」在事实源中未命中（可能名称有误、已关闭，或来源不覆盖该地区）。`,
          { day: day.day, spot: spot.name, source },
          "facts",
          "blocking",
        );
      } else if (existence === "error") {
        counts.poiError += 1;
        sourceErrors.push(spot.name);
      } else {
        counts.poiNotChecked += 1;
        unverifiedNames.push(spot.name);
      }

      const hoursState = v.hours ?? "not_checked";
      if (hoursState === "hit") {
        counts.hoursChecked += 1;
        const input = hoursInput(spot);
        const range = parseTimeRange(spot.time);
        if (input && range && isRealDate(day.date)) {
          const r = checkOpenHours({ ...input, name: spot.name }, day.date, range.start, range.end);
          if (r.state === "closed" || r.state === "outside") {
            add(
              "TC-F204",
              `第 ${day.day} 天（${day.date}）「${spot.name}」安排 ${spot.time}，但营业时间对不上：${r.reason}`,
              { day: day.day, date: day.date, spot: spot.name, raw: spot.time, source },
              "facts",
              "blocking",
            );
          } else if (r.state === "unknown") {
            hoursUnverified.count += 1;
            hoursUnverified.names.push(spot.name);
          }
        } else {
          // 有「营业时间」标记，却缺原文/日期/时间轴：判不了，如实计入未判定
          hoursUnverified.count += 1;
          hoursUnverified.names.push(spot.name);
        }
      } else if (hoursState === "miss" || hoursState === "not_checked") {
        if (hoursState === "not_checked") counts.hoursNotChecked += 1;
        else counts.hoursMiss += 1;
        hoursUnverified.count += 1;
        hoursUnverified.names.push(spot.name);
      } else {
        counts.hoursError += 1;
        sourceErrors.push(spot.name);
      }
    }
  }

  // 路段事实：每个相邻点对一段；只在有 durationMin 时算「查到了」（每天只数一遍）
  for (const day of days) {
    const spots = day.spots ?? [];
    for (let i = 0; i < spots.length - 1; i += 1) {
      const leg = findLeg(day.legs, spots[i].name, spots[i + 1].name);
      counts.routesTotal += 1;
      if (legMinutes(leg) !== null && leg?.state !== "error") counts.routesChecked += 1;
      if (leg?.state === "error") counts.routesError += 1;
    }
  }

  // 聚合事实问题（一条规则一次，避免逐点刷屏；证据里给数量与前几个名字）
  if (counts.poiNotChecked > 0) {
    add(
      "TC-F201",
      `有 ${counts.poiNotChecked} 个地点未声明存在性核验（未核验 ≠ 不存在；这是「不知道」）：${unverifiedNames.slice(0, 3).join("、")}${unverifiedNames.length > 3 ? " 等" : ""}。`,
      { count: counts.poiNotChecked, names: unverifiedNames.slice(0, 3), field: "existence" },
      "facts",
      "info",
    );
  }
  if (hoursUnverified.count > 0) {
    add(
      "TC-F203",
      `有 ${hoursUnverified.count} 个地点的营业时间不可用（未查/来源没有/原文无法解析），不能假装知道它几点开门：${hoursUnverified.names.slice(0, 3).join("、")}${hoursUnverified.names.length > 3 ? " 等" : ""}。`,
      { count: hoursUnverified.count, names: hoursUnverified.names.slice(0, 3), field: "hours" },
      "facts",
      "info",
    );
  }
  if (counts.poiError + counts.hoursError + counts.routesError > 0) {
    add(
      "TC-F205",
      `有 ${counts.poiError + counts.hoursError + counts.routesError} 条事实查询失败（上游波动/限流/超时）——这是「不知道」，不是「地点不存在」。`,
      {
        count: counts.poiError + counts.hoursError + counts.routesError,
        names: sourceErrors.slice(0, 3),
        field: "source",
      },
      "facts",
      "info",
    );
  }

  // ============================================================
  // 3) 两轴结论 + 总分（结构轴扣分；事实轴用覆盖表达）
  // ============================================================
  const consistencyIssues = issues.filter((i) => i.category === "consistency");
  const penaltyHits = new Map<string, number>();
  let deducted = 0;
  for (const issue of consistencyIssues) {
    const meta = RULES[issue.ruleId];
    const hits = penaltyHits.get(issue.ruleId) ?? 0;
    if (!meta || meta.penalty <= 0 || hits >= PENALTY_MAX_HITS) continue;
    penaltyHits.set(issue.ruleId, hits + 1);
    deducted += meta.penalty;
  }
  const score = Math.max(0, Math.min(100, 100 - deducted));
  const blocking = issues.filter((i) => i.severity === "blocking");
  // 等级直接由分数阈值决定，保证「分数 ↔ 等级」可对账（阻断级规则单条 45 分，
  // 一次就跌破 60，见 rules.ts 的扣分表）。
  const grade = gradeOf(score);
  const warningCount = severityCount(issues, "warning");
  const infoCount = severityCount(issues, "info");

  const consistency: ConsistencyVerdict = {
    score,
    grade,
    gradeLabel: GRADE_LABEL[grade],
    summary:
      blocking.length > 0
        ? `结构体检发现 ${blocking.length} 处阻断问题（${topTitles(issues)}），按文档给出的数据这份行程走不通。`
        : warningCount > 0
          ? `结构体检有 ${warningCount} 处需要微调（${issues
              .filter((i) => i.severity === "warning")
              .slice(0, 2)
              .map((i) => i.title)
              .join("、")}），没有阻断问题。`
          : "结构体检未发现阻断或需微调的问题。",
  };

  // 事实轴的 verified：存在性 + 路线 + 营业时间都「查过或来源确无数据」，且无查询失败。
  // 注意：营业时间 miss（来源没有这条数据）算「查过」，不阻碍 verified——
  // 数据源没有营业时间不是文档的错，覆盖率会把它如实展示出来。
  const existenceOk = counts.poiTotal > 0 && counts.poiChecked === counts.poiTotal;
  const routesOk = counts.routesTotal === 0 || counts.routesChecked === counts.routesTotal;
  const hoursResolved =
    counts.hoursChecked + counts.hoursMiss + counts.hoursNotChecked + counts.hoursError;
  const hoursOk =
    counts.poiTotal > 0 &&
    hoursResolved === counts.poiTotal &&
    counts.hoursNotChecked === 0 &&
    counts.hoursError === 0;
  const anyChecked = counts.poiChecked > 0 || counts.routesChecked > 0 || counts.hoursChecked > 0;
  const factsState: FactsVerdict["state"] =
    counts.poiTotal === 0
      ? "inconclusive"
      : existenceOk && routesOk && hoursOk && counts.poiError === 0 && counts.routesError === 0
        ? "verified"
        : anyChecked
          ? "partial"
          : "unverified";

  const factsSummary: Record<FactsVerdict["state"], string> = {
    verified: `事实核验：${counts.poiHit}/${counts.poiTotal} 个地点已核验，${counts.routesChecked}/${counts.routesTotal} 段路程有真实耗时，营业时间 ${counts.hoursChecked}/${counts.poiTotal} 有来源数据。`,
    partial: `事实核验：只覆盖了一部分（地点 ${counts.poiChecked}/${counts.poiTotal}、路段 ${counts.routesChecked}/${counts.routesTotal}、营业时间 ${counts.hoursChecked}/${counts.poiTotal}），未覆盖部分不能当作已验证。`,
    unverified:
      "事实核验：文档没有声明可用的核验来源——结构可以检查，但地点是否真实、是否开门、路程是否可行都未核验。",
    inconclusive: "事实核验：没有可核验的点位。",
  };

  const overall: OverallStatus =
    blocking.length > 0
      ? "blocking"
      : warningCount > 0
        ? "warnings"
        : factsState === "verified"
          ? "ok"
          : "unverified";

  const facts: FactsVerdict = {
    state: factsState,
    summary: factsSummary[factsState],
    coverage: {
      poiTotal: counts.poiTotal,
      poiChecked: counts.poiChecked,
      poiHit: counts.poiHit,
      poiMiss: counts.poiMiss,
      poiError: counts.poiError,
      poiNotChecked: counts.poiNotChecked,
      hoursChecked: counts.hoursChecked,
      routesTotal: counts.routesTotal,
      routesChecked: counts.routesChecked,
    },
    sources: sourceCounts,
  };

  // 排序：阻断 → 微调 → 信息；同严重度按天、规则 ID，保证报告稳定可 diff
  issues.sort((a, b) => {
    const bySeverity = SEVERITY_WEIGHT[a.severity] - SEVERITY_WEIGHT[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const dayDiff = (a.evidence.day ?? 0) - (b.evidence.day ?? 0);
    if (dayDiff !== 0) return dayDiff;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return {
    specVersion: TRIP_CHECK_SPEC_VERSION,
    engine: {
      name: TRIP_CHECK_ENGINE_NAME,
      version: TRIP_CHECK_ENGINE_VERSION,
      rulesetVersion: TRIP_CHECK_RULESET_VERSION,
    },
    document: {
      ...(doc.id ? { id: doc.id } : {}),
      ...(doc.city ? { city: doc.city } : {}),
      days: days.length,
      spots: allSpots.length,
      ...(typeof doc.budgetCny === "number" ? { budgetCny: doc.budgetCny } : {}),
    },
    verdict: {
      consistency,
      facts,
      overall,
      summary: `${consistency.summary}${facts.summary}`,
    },
    issues,
    stats: {
      blocking: blocking.length,
      warnings: warningCount,
      infos: infoCount,
      total: issues.length,
    },
    ruleset: {
      version: TRIP_CHECK_RULESET_VERSION,
      ruleIds: RULE_IDS,
    },
    checkedAt: now.toISOString(),
  };
}
