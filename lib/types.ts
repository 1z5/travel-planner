// ---------- 用户输入 ----------
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
  events?: PlanEvent[]; // 用户指定的重点活动（演唱会/赛事/展览等，需编进行程）
  transportMode?: TransportMode; // 交通方式：决定每天各景点间怎么走（默认 driving）
}

/** 交通方式：景点间路段用哪种方式串起来。公交/地铁当前高德 key 未开放，先不做 */
export type TransportMode = "walking" | "bicycling" | "driving";

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

export interface Plan {
  city: string;
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
  verification?: "mock" | "ok" | "partial" | "pending"; // 验真完成度：mock=未接高德 / ok=全部核完 / partial=高德波动部分未核 / pending=流式生成中尚未收尾
}
