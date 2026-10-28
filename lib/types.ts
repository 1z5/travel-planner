// ---------- 用户输入 ----------
import type { TravelProfile } from "./profile";

export interface PlanInput {
  city: string; // 目的地城市，如 "成都"
  days: number; // 天数（由起止时间推导，1-4）
  startAt?: string; // 起始时间 "YYYY-MM-DDTHH:mm"（本地时间）
  endAt?: string; // 结束时间 "YYYY-MM-DDTHH:mm"（本地时间）
  budget: number; // 人均总预算（不含大交通）
  preferences: string[]; // 偏好标签
  hotel?: string; // 用户指定住所（酒店名/区域），如 "全季酒店(春熙路店)" 或 "住春熙路附近"
  mustVisit?: string[]; // 期望必游地（硬约束，必须全部出现在行程中）
  pace?: "relaxed" | "balanced" | "packed"; // 行程节奏：轻松/适中/紧凑（默认适中）
  scope?: "city" | "region"; // 规划范围：city=单城市（默认）/ region=区域环线（如川西环线、关西）
  /**
   * 跨城/多城市行程（有序）：如深圳 2 天 + 香港 2 天。
   *
   * 为什么不是复用 region：region 是「一个松散区域内的环线」（川西、关西），
   * POI 检索要关掉 citylimit；跨城是「几座具体城市按天串段」，每座城仍按
   * city 模式精确检索（citylimit 开着），否则深圳的POI会混进香港段。
   *
   * days 之和必须等于由起止时间推导的总天数（API 校验）。出现该字段即视为
   * 跨城模式：prompt 按天分配城市、事实层逐城检索、体检按天所属城市验真。
   * 跨境段（深港）**不估算通勤**——高德不做跨境路线，用户提供的班次时间
   * 以重点活动（events）形式作为锚点，我们不编造口岸排队/检录时间。
   */
  cities?: TripCity[];
  events?: PlanEvent[]; // 用户指定的重点活动（演唱会/赛事/展览等，需编进行程）
  transportMode?: TransportMode; // 交通方式：决定每天各景点间怎么走（默认 driving；auto=按距离自动混选）
  /**
   * 旅行档案（切片3 · 旅行档案）：客户端 localStorage 里的长期记忆
   * （体力/忌口/作息/通勤耐受/推断偏好），随请求带上。
   *
   * 为什么是可选字段：无档案时全链路行为与切片 3 之前完全一致（向后
   * 兼容红线——planner/validate 看到 undefined 就一行档案行都不加）。
   * 有档案时 planner.baseLines 追加档案行、validate 按 stamina 调整
   * 节奏阈值。类型放在这里（而不是 planner/validate 内部 cast）是为了
   * 让「档案是输入的一等字段」在类型层可见——避免「改一处漏一处」的
   * 历史坑（见 planner.ts SpotSchema 的注释）。
   *
   * 服务端不信任这个字段的值：会进 prompt 的用户数据必须过字符白名单
   * （lib/profile.ts 的 validateProfile，与 city/hotel 同等口径）。
   */
  profile?: TravelProfile;
}

/** 交通方式：景点间路段用哪种方式串起来。公交/地铁当前高德 key 未开放，先不做 */
export type TransportMode = "walking" | "bicycling" | "driving" | "auto";

/** 跨城行程中的一座城市及其天数（有序，days 之和 = 总天数） */
export interface TripCity {
  city: string;
  days: number;
}

/** 用户指定的重点活动。时间可选——给了就围绕它倒推动线，没给则由 AI 建议 */
export interface PlanEvent {
  name: string; // 活动名称，如 "周杰伦演唱会" 或 "莫奈特展"
  date?: string; // "YYYY-MM-DD"（可选）
  time?: string; // "HH:mm"（可选，开始时间）
}

// ---------- 行程结构（LLM 按此 schema 输出） ----------
export type Period = "morning" | "lunch" | "afternoon" | "dinner" | "evening";
export type SpotType = "sight" | "food" | "hotel" | "transport" | "shopping" | "activity";

export interface PlanSpot {
  period: Period;
  time: string; // "09:00-11:30"
  type: SpotType;
  name: string; // POI 名称
  area: string; // 所在商圈/区域（同区聚合减少绕路）
  durationMin: number; // 停留分钟数
  costCny: number; // 人均花费
  reason: string; // 为什么去这里
  rainBackup?: string; // 雨天备选（室外景点必填）
  location?: string; // "经度,纬度"（验真命中时由高德回填，「行中」定位算「我离这站多远」用）
  // 高德 POI 详情（验真命中且 extensions=all 有数据时回填）。
  // 为什么单独放一层而不是塞进 PlanSpot 顶层：这些字段**不是** LLM 生成的，
  // 是验真接口返回的事实；分层后 UI/体检能严格区分「模型说的」与「高德证的」。
  // 缺字段 = 高德没给，不代表任何默认值（MOCK 模式一律不填，见 lib/amap.ts）。
  poi?: SpotPoiMeta;
}

/**
 * 高德 POI 的「真实世界约束」数据（评分/人均/营业时间/电话/停业状态）。
 * 全部可选：高德返回空数组（`[]`）或缺字段时就是不填，绝不猜默认值。
 * 解析入口在 lib/amap.ts 的 lookupPoi；营业时间文本的判定在 lib/poi-hours.ts。
 */
export interface SpotPoiMeta {
  rating?: number; // 高德评分（"4.8" → 4.8）
  avgCostCny?: number; // 高德人均消费（"65.00" → 65；餐饮/景点有则给）
  openTime?: string; // open_time 原文（简版，如 "09:00-17:00"/"24小时营业"）
  openTime2?: string; // opentime2 原文（复杂：季节分段/闭馆日/最晚进入）
  tel?: string; // 联系电话原文
  temporarilyClosed?: boolean; // 名称含「暂停开放/暂停营业/已关闭」（高德用名称表达停业状态）
}

export interface PlanDay {
  day: number;
  /** 跨城行程：这一天所属城市（finalizePlan 按 input.cities 回填；单城市为 undefined） */
  city?: string;
  theme: string;
  spots: PlanSpot[];
  transitMin: number; // 当天站点间通勤合计（validate 回填真实估算）
  transitKnown?: boolean; // false = 通勤估算失败（高德波动），该天未做通勤/节奏判定
  legs?: PlanLeg[]; // 景点间分段路线（按 transportMode 算；旧行程无此字段）
  dailyCostCny: number; // 人均当天花费（validate 回填）
}

/** 景点间的一段路线：从上一站到这一站怎么走 */
export interface PlanLeg {
  from: string; // 起点景点名
  to: string; // 终点景点名
  mode: TransportMode; // 交通方式
  distanceM: number; // 距离（米）
  durationSec: number; // 时长（秒）
  steps: string[]; // 关键分步指令（取前几条，够跟着走）
}

/**
 * 事实先行的核验摘要：生成前喂给模型的那份「真实素材清单」有多大。
 * 用于在 UI 上如实告诉用户「这份行程是在多少个已核验候选上排出来的」。
 */
export interface PlanGrounding {
  candidates: number; // 清单里的候选地点数
  closedSkipped: number; // 其中标了闭馆日、已提示模型避开的数量
  closedOut: number; // 全程闭馆、直接从清单剔除的数量
}

export interface Plan {
  city: string; // 目的地（跨城行程为首站城市；plan.cities 才是完整分段）
  /** 跨城/多城市分段（有序；单城市行程为 undefined） */
  cities?: TripCity[];
  startDate?: string; // 行程首日 "YYYY-MM-DD"（日历导出/结果卡/分享页展示）
  endDate?: string; // 行程末日 "YYYY-MM-DD"
  startAt?: string; // 完整起始时间 "YYYY-MM-DDTHH:mm"（结果卡展示）
  endAt?: string; // 完整结束时间 "YYYY-MM-DDTHH:mm"
  summary: string;
  days: PlanDay[];
  totalCostCny: number;
  // 用户输入的人均预算（由 validate.finalizePlan 从 PlanInput 回填）。
  // 结果页要算「预算使用率」就必须有它——旧数据 / 示例行程 / 早期分享可能没有，
  // 所以是可选字段：UI 侧必须按「无预算」优雅降级（只展示实际花费与构成，不猜使用率）。
  budgetCny?: number;
  tips: string[]; // 预约/避坑提示
  warnings: string[]; // 体检结果：未验真 POI / 通勤偏长 / 节奏 / 预算
  verified: boolean; // 是否走了真实高德数据（false = mock 模式）
  verification?: "mock" | "ok" | "partial" | "pending";
  /**
   * 核验完成时间（ms）：分享页/工作台的「可执行性评分卡」要把证据时间摊给用户
   * （「什么时候核的」是可信度的一部分）。MOCK 模式不写——没核过就没有时间。
   * 旧行程缺这个字段时 UI 不展示时间，不拿生成时间冒充核验时间。
   */
  verifiedAt?: number;
  draft?: boolean; // true = 即时草稿预览（LLM 真实行程生成后替换）
  /**
   * 草稿种类：
   *   fast = 秒级初版（真实 POI 名单 + 确定性规则，动线未精排）
   *   skeleton = 结构骨架（<100ms，POI 名是占位符；legacy，仅无 grounding 时）
   * 缺省视为 skeleton——旧数据/无 grounding 路径行为不变。
   */
  draftKind?: "fast" | "skeleton";
  /**
   * 核验差异报告：秒级初版 → 精排版之间，核验层实际做了什么。
   * 每个数字都可溯源（POI 存在性/闭馆/真实路段/时间修正），没有的一项不写。
   */
  verificationReport?: {
    fastDraftSpots: number; // 初版真实 POI 数
    keptInFinal: number; // 精排版保留的初版 POI 数
    closedSkipped: number; // 避开闭馆日的候选数
    closedOut: number; // 全程闭馆被剔除的候选数
    realLegs: number; // 精排版算出的真实路段数
    timeFixed: number; // 初版「时间接不上」在精排版被修正的段数（近似：初版未算通勤，按真实路段数计）
  }; // 验真完成度：mock=未接高德 / ok=全部核完 / partial=高德波动部分未核 / pending=流式生成中尚未收尾
  grounding?: PlanGrounding; // 事实先行摘要（生成前用真实 POI 事实约束过模型）
  /**
   * 演示/种子行程标记（DEMO_SEED 注入的 fixture）。
   *
   * 为什么：演示 token 写在公开的 DEMO.md 里，若允许写操作，任何人可改演示工件
   * （安全审计 R4）。带这个标记的 Plan 在 refine/restore/repair/adjust 等写端点
   * 一律 403 只读；克隆不受影响（克隆生成的是新 Plan）。
   */
  demo?: boolean;
  /**
   * Trip Check 元数据（v9 起）：这份行程最近一次确定性修复的凭据链与计数。
   *
   * 为什么存在 Plan 里而不是另建表：核验结论可由 plan 随时重算，但「用户确实
   * 采纳过修复」是一个**事件事实**（父凭据 → 子凭据、修复了几处、第几版），
   * 重算不出来。Plan 本身是 JSON 聚合（revision 已经承载版本语义），放这里
   * 不引入迁移，也能让分享页/工作台直接展示「已修复」的证据链。
   *
   * 诚实边界：只记录 mechanical repair（顺延/去重）；不写「体检通过」之类的
   * 主观结论——那由 Trip Check 报告实时判定，不能固化成历史声明。
   */
  tripCheck?: {
    /** 最近一次修复后的凭据（子） */
    credentialId: string;
    /** 修复前的凭据（父）；没有修复过则缺省 */
    parentCredentialId?: string;
    /** 最近一次核验/修复的时间（ms） */
    checkedAt: number;
    /** 最近一次修复时间（ms）；只做 check 不修复时缺省 */
    repairedAt?: number;
    /** 累计确定性修复次数（每次持久化 +1） */
    repairCount?: number;
    /** 最近一次修复应用的机械变换条数 */
    applied?: number;
  };
}
