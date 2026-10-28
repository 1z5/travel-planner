// ============================================================
// Trip Check：行程可执行性核验开放标准 v0.1（类型契约）
//
// 为什么要有这一层（2026-10 全球调研结论见 docs/PRODUCT-REVOLUTION-2026-10.md）：
// 1) 「生成行程」已经被大厂与 agent 商品化（ChatGPT/Claude 里点一下就有）；
// 2) 基础规则体检也被数据源自己做成了原生功能（高德 2026 的 15 维推演）；
// 3) 但平台明确「不背责任」——错误一旦规模化，就需要**可复算、可对账的核验**。
// 所以本产品的形态从「卖行程」升级为「卖证据」：同一套确定性引擎既服务自家
// 行程，也能对**任何第三方行程**给出可复现的体检结论。
//
// 本文件只放契约（类型/常量），不放判定逻辑：
// - engine.ts 是纯函数判定（client-safe，可在浏览器/Node/测试里跑同一份规则）；
// - 不 import server-only、不发网络请求 —— 开放标准必须任何人都能独立复算。
//
// 三个刻意的设计取舍：
// 1) **两轴结论**：结构自洽性（时间轴/节奏/预算，只靠文档就能判）与事实核验
//    （地点是否存在、营业时间是否对得上，取决于文档声明的来源与三态）分开。
//    一份文档可以「结构 A 级、事实未核验」——把两件事混成一个分数就是骗人。
// 2) **三态透传**：事实来源只有 hit/miss/error/not_checked 四态，不把「没查」
//    说成「没问题」，也不把上游故障说成「地点不存在」。
// 3) **可复算凭据**：同一份文档 + 同一引擎/规则版本 → 同一 credential.id；
//    任何人都能独立重跑核对（见 credential.ts 与 docs/TRIP-CHECK-STANDARD.md）。
// ============================================================

/** 规范版本：文档格式的语义化版本。不兼容变更必须升 minor（0.1 → 0.2） */
export const TRIP_CHECK_SPEC_VERSION = "trip-check/0.1";

/** 引擎名（报告里带，便于对方核对是哪套实现出的结论） */
export const TRIP_CHECK_ENGINE_NAME = "trip-check";

/** 引擎版本：判定/修复逻辑变化时递增（与规则集版本分开：引擎修 bug 不该改规则口径） */
export const TRIP_CHECK_ENGINE_VERSION = "0.2.0";

/** 规则集版本：规则增删/阈值调整时递增。凭据 ID 绑定它，保证「同一结论可追」 */
export const TRIP_CHECK_RULESET_VERSION = "2026-10-28.1";

/** 输入限制：开放 API 的防滥用边界，不参与判定语义（超限由 API 层 400/413） */
export const TRIP_CHECK_LIMITS = {
  maxDays: 30,
  maxSpotsPerDay: 40,
  maxSpots: 200,
  maxNameChars: 120,
  maxBudgetCny: 10_000_000,
} as const;

/** 事实来源：文档必须声明数据从哪来，才能被当成「可核验」 */
export type VerifySource = "amap" | "google_places" | "osm" | "manual" | "mock" | "other";

/**
 * 事实三态（+ 未查）。
 * - hit：从来源查到了这条事实
 * - miss：查到了、但来源没有这条事实（例如该 POI 无营业时间数据）
 * - error：查询失败（上游故障/限流/超时）——这是「不知道」，不是「不存在」
 * - not_checked：文档没声明查过
 */
export type FactState = "hit" | "miss" | "error" | "not_checked";

/** 单个点位的事实核验状态（开放文档由生成方填写，自家行程由 adapt.ts 回填） */
export interface SpotVerification {
  /** 这条事实的来源（缺省时继承文档级 provenance） */
  source?: VerifySource;
  /** 地点存在性核验（POI 检索命中/未命中/查询失败/未查） */
  existence?: FactState;
  /** 营业时间获取（拿到可解析文本=hit；来源没有=miss；查询失败=error） */
  hours?: FactState;
  /** 核验时间（ISO 8601）。没核过就不写——不拿生成时间冒充核验时间 */
  checkedAt?: string;
}

/** 营业时间原文（与高德 open_time/opentime2 同构，解析交给 poi-hours.ts） */
export interface DocHours {
  openTime?: string;
  openTime2?: string;
  temporarilyClosed?: boolean;
}

/** 行程点位（开放文档的最小单位；不要求坐标，但坐标能提高可判定度） */
export interface DocSpot {
  /** 名称（必填；判重、路段匹配都按名称） */
  name: string;
  /** 时段 "HH:MM-HH:MM"（必填；缺失/非法会产出一条规则问题，而不是猜时间） */
  time: string;
  type?: "sight" | "food" | "hotel" | "transport" | "shopping" | "activity";
  /** 停留分钟数。缺省时节奏判定跳过（不按 0 计） */
  durationMin?: number;
  /** 人均花费（人民币元） */
  costCny?: number;
  /** 所在商圈/区域 */
  area?: string;
  /** "经度,纬度"（有坐标说明做过空间核验；但存在性以 verification.existence 为准） */
  location?: string;
  /** 营业时间原文；有没有值不代表查没查过，查没查过看 verification.hours */
  hours?: DocHours;
  verification?: SpotVerification;
}

/** 相邻点位之间的路段（有 durationMin 才能判「时间接不接得上」） */
export interface DocLeg {
  from: string;
  to: string;
  mode?: "walking" | "bicycling" | "driving" | "transit" | "auto";
  /** 路段耗时（分钟）。缺省 = 没有真实路段数据，不按 0 分钟假装接得上 */
  durationMin?: number;
  distanceM?: number;
  /** 路段数据来源与状态（缺省视为 not_checked） */
  source?: VerifySource;
  state?: FactState;
}

/** 一天 */
export interface DocDay {
  /** 第几天（从 1 开始；同一文档内必须唯一） */
  day: number;
  /** 日期 "YYYY-MM-DD"；没有日期时营业时间判定跳过（不猜是周几） */
  date?: string;
  city?: string;
  spots: DocSpot[];
  /** 当天相邻点位的路段（可选；没有就诚实说「无法判断通勤」） */
  legs?: DocLeg[];
}

/** 文档级事实来源（点位/路段未单独声明时的默认值） */
export interface DocProvenance {
  poi?: { source: VerifySource; checkedAt?: string };
  routes?: { source: VerifySource; checkedAt?: string };
  hours?: { source: VerifySource; checkedAt?: string };
}

/**
 * 开放行程文档（Trip Check v0.1）。
 * 这份格式刻意贴近本项目内部的 Plan（可直接适配），但不依赖它——
 * 任何 AI 行程生成器都能填。
 */
export interface TripCheckDocument {
  specVersion: string;
  id?: string;
  city?: string;
  days: DocDay[];
  /** 人均总预算（人民币元）；没有就不做预算判定 */
  budgetCny?: number;
  provenance?: DocProvenance;
}

/** 判定口径（会写进报告与凭据 ID：同样文档换个口径结论可以不同，必须可追） */
export interface TripCheckOptions {
  /** 行程节奏：决定日净游玩时长上限（默认 balanced） */
  pace?: "relaxed" | "balanced" | "packed";
}

/** 问题严重度：blocking=走不通；warning=需要微调；info=信息不足/提示 */
export type IssueSeverity = "blocking" | "warning" | "info";

/** 问题分类：consistency=结构自洽性（只靠文档可判）；facts=事实核验（依赖来源） */
export type IssueCategory = "consistency" | "facts";

/** 可对账的证据（结构化，不用自然语言糊弄） */
export interface IssueEvidence {
  day?: number;
  date?: string;
  spot?: string;
  from?: string;
  to?: string;
  minutes?: number;
  needMinutes?: number;
  gapMinutes?: number;
  count?: number;
  names?: string[];
  field?: string;
  source?: VerifySource;
  /** 原始时刻文本（时间格式非法时保留输入，便于定位） */
  raw?: string;
  /** 金额类证据（预算/花费，人民币元） */
  amountCny?: number;
  budgetCny?: number;
  /** 阈值类证据（节奏上限分钟数等） */
  limitMinutes?: number;
}

/** 一条规则问题 */
export interface VerifyIssue {
  ruleId: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  /** 人话说明（含真实数字，不堆术语） */
  detail: string;
  evidence: IssueEvidence;
  /** 修复方向（不是自动修：本引擎只判定，不改行程） */
  fixHint?: string;
  /**
   * 基于**文档自带事实**算出的建议（例如营业时间冲突时给出当天可用的营业时段）。
   * 与 fixHint 的区别：fixHint 是方向性文案，suggestion 是从声明数据里算出来的
   * 具体选项；拿不到数据就没有这个字段（不猜、不给「建议你去 X 点」）。
   */
  suggestion?: string;
}

/** 结构自洽性结论（可执行性评分只在这一轴） */
export interface ConsistencyVerdict {
  /** 0-100；只由结构问题扣分 */
  score: number;
  grade: "A" | "B" | "C" | "D";
  gradeLabel: string;
  summary: string;
}

/** 事实核验结论（证据轴：不看分数看覆盖与三态） */
export interface FactsVerdict {
  /**
   * verified：所有点位存在性 + 全部相邻路段都已核验（无 error）
   * partial：部分核验过（存在 error 或只覆盖一部分）
   * unverified：文档没有声明任何可用的核验来源
   * inconclusive：没有可核验的点位（空文档/只有交通段）
   */
  state: "verified" | "partial" | "unverified" | "inconclusive";
  summary: string;
  coverage: {
    /** 参与存在性核验的点位数（不含 type=transport 的移动描述） */
    poiTotal: number;
    poiChecked: number; // existence 为 hit/miss 的数量
    poiHit: number;
    poiMiss: number;
    poiError: number;
    poiNotChecked: number;
    /** 有营业时间数据的点位数（hours=hit） */
    hoursChecked: number;
    /** 相邻路段总数 / 有真实耗时的段数 */
    routesTotal: number;
    routesChecked: number;
  };
  /** 出现过的来源（来源 → 点位数），供「谁的数据」一眼可查 */
  sources: Partial<Record<VerifySource, number>>;
}

/** 总体结论（是否可照着走 + 证据是否够） */
export type OverallStatus = "ok" | "warnings" | "blocking" | "unverified";

/** 凭据：可复算的核验凭证（server 端生成；报告里带，便于第三方重跑对账） */
export interface TripCheckCredential {
  /** 确定性 ID：同一文档+口径+引擎/规则版本 → 同一 ID */
  id: string;
  algorithm: "sha256";
  /** 输入哈希（document + options 的规范 JSON） */
  inputHash: string;
  specVersion: string;
  engineVersion: string;
  rulesetVersion: string;
  issuedAt: string;
  /** ID 的计算口径，写死在公开文档里，任何人都能复算 */
  basis: string;
}

/** 报告主体 */
export interface TripCheckReport {
  specVersion: string;
  engine: {
    name: string;
    version: string;
    rulesetVersion: string;
  };
  document: {
    id?: string;
    city?: string;
    days: number;
    spots: number;
    budgetCny?: number;
  };
  verdict: {
    consistency: ConsistencyVerdict;
    facts: FactsVerdict;
    overall: OverallStatus;
    /** 一句话总评：先回答「能不能照着走」，再说「证据够不够」 */
    summary: string;
  };
  issues: VerifyIssue[];
  stats: {
    blocking: number;
    warnings: number;
    infos: number;
    total: number;
  };
  /** 规则集元信息（版本 + 规则清单），便于对账 */
  ruleset: {
    version: string;
    ruleIds: string[];
  };
  checkedAt: string;
  credential?: TripCheckCredential;
}

/** 单条规则元信息（导出给 API/MCP/文档，UI 不重复维护一套文案） */
export interface VerifyRuleMeta {
  id: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  description: string;
  /** 结构问题扣分（事实问题不扣结构分，两轴分开） */
  penalty: number;
  fixHint?: string;
  /** 规则引入版本（用于「这条规则什么时候开始生效」的对账） */
  since: string;
  /**
   * 可机械修复的规则（确定性、不编造数据）：
   * - retime：顺延当天时间轴（重叠/接不上）
   * - dedupe：删除同一天重复点位
   * 没有这个字段 = 只能人工改（缺数据/换点/预算等），修复器不假装能修。
   */
  mechanicalFix?: "retime" | "dedupe";
}

// ============================================================
// Trip Check Repair：从「判定」到「确定性修复 + 修复前后凭据」
//
// 为什么需要（2026-10 调研的最强空白）：43% 的 AI 行程日含可验证错误，但竞品
// 都只提醒不修；产品内已有「一键修复」，却只服务自家行程。开放核验层如果只判
// 不修，第三方拿到报告仍然要手改。修复器把「评分 + 证据 + 修复 + 重验」补成闭环，
// 并且用前后两张凭据把「改了什么、风险降了多少」变成可对账的事实。
//
// 铁律：只做**有数据依据、不改变语义**的机械变换（顺延时间、删重复条目）。
// 不编造地点/营业时间/路段，不删用户没要求删的独立点位，不替用户做取舍。
// ============================================================

/** 修复动作（逐条可对账；kind 与规则集的 mechanicalFix 对应） */
export interface RepairApplied {
  /** 修复掉的规则（TC-C102 / TC-C103 / TC-C109） */
  ruleId: string;
  day: number;
  spot?: string;
  /**
   * 被修复点在**输入文档当天 spots 数组里的原始下标**（0 基）。
   * 为什么需要：产品侧要把「修复后文档」的变更套回内部 Plan（Plan 有 period/
   * reason/rainBackup 等文档里没有的字段）。按名称套不稳（重复点正是要删的那种），
   * 按下标才可逆；删除类修复按原始下标降序应用即可。
   */
  spotIndex?: number;
  /** 时间类修复：原时刻（"HH:MM-HH:MM"） */
  from?: string;
  /** 时间类修复：新时刻 */
  to?: string;
  /** 人话说明（含前后时刻/具体动作，供人类复核） */
  detail: string;
}

/** 无法机械修复的残留问题（必须如实告诉调用方「为什么修不了」） */
export interface RepairUnrepairable {
  ruleId: string;
  day?: number;
  spot?: string;
  reason: string;
}

export interface RepairResult {
  /** 修复后的开放文档（新对象；入参不被修改） */
  document: TripCheckDocument;
  /** 已应用的确定性修复（空数组 = 本来就没得修/不需要修） */
  applied: RepairApplied[];
  /** 修复后仍存在、但不在机械修复范围内的规则（去重后的 ID，便于快速判断） */
  remainingRuleIds: string[];
  /** 逐条说明为什么修不了（给用户/agent 的下一步指引） */
  unrepairable: RepairUnrepairable[];
  before: TripCheckReport;
  after: TripCheckReport;
  delta: {
    /** 结构分变化（修复后 - 修复前；可为 0） */
    score: number;
    gradeFrom: "A" | "B" | "C" | "D";
    gradeTo: "A" | "B" | "C" | "D";
    /** 阻断问题数变化（修复前 - 修复后；正数 = 减少了） */
    blockingReduced: number;
    /** 是否真的改善了（分数提高 或 阻断减少 或 等级上升） */
    improved: boolean;
  };
}
