// ---------- 用户输入 ----------
export interface PlanInput {
  city: string;            // 目的地城市，如 "成都"
  days: number;            // 天数（由起止时间推导，1-4）
  startAt?: string;        // 起始时间 "YYYY-MM-DDTHH:mm"（本地时间）
  endAt?: string;          // 结束时间 "YYYY-MM-DDTHH:mm"（本地时间）
  budget: number;          // 人均总预算（不含大交通）
  preferences: string[];   // 偏好标签
  hotel?: string;          // 用户指定住所（酒店名/区域），如 "全季酒店(春熙路店)" 或 "住春熙路附近"
  mustVisit?: string[];    // 期望必游地（硬约束，必须全部出现在行程中）
  pace?: "relaxed" | "balanced" | "packed"; // 行程节奏：轻松/适中/紧凑（默认适中）
}

// ---------- 行程结构（LLM 按此 schema 输出） ----------
export type Period = "morning" | "lunch" | "afternoon" | "dinner" | "evening";
export type SpotType = "sight" | "food" | "hotel" | "transport" | "shopping" | "activity";

export interface PlanSpot {
  period: Period;
  time: string;            // "09:00-11:30"
  type: SpotType;
  name: string;            // POI 名称
  area: string;            // 所在商圈/区域（同区聚合减少绕路）
  durationMin: number;     // 停留分钟数
  costCny: number;         // 人均花费
  reason: string;          // 为什么去这里
  rainBackup?: string;     // 雨天备选（室外景点必填）
}

export interface PlanDay {
  day: number;
  theme: string;
  spots: PlanSpot[];
  transitMin: number;      // 当天站点间通勤合计（validate 回填真实估算）
  transitKnown?: boolean;  // false = 通勤估算失败（高德波动），该天未做通勤/节奏判定
  dailyCostCny: number;    // 人均当天花费（validate 回填）
}

export interface Plan {
  city: string;
  startDate?: string;       // 行程首日 "YYYY-MM-DD"（日历导出/结果卡/分享页展示）
  endDate?: string;         // 行程末日 "YYYY-MM-DD"
  startAt?: string;         // 完整起始时间 "YYYY-MM-DDTHH:mm"（结果卡展示）
  endAt?: string;           // 完整结束时间 "YYYY-MM-DDTHH:mm"
  summary: string;
  days: PlanDay[];
  totalCostCny: number;
  tips: string[];          // 预约/避坑提示
  warnings: string[];      // 体检结果：未验真 POI / 通勤偏长 / 节奏 / 预算
  verified: boolean;       // 是否走了真实高德数据（false = mock 模式）
  verification?: "mock" | "ok" | "partial" | "pending"; // 验真完成度：mock=未接高德 / ok=全部核完 / partial=高德波动部分未核 / pending=流式生成中尚未收尾
}
