// ---------- 用户输入 ----------
export interface PlanInput {
  city: string;            // 目的地城市，如 "成都"
  days: number;            // 天数，3-5
  budget: number;          // 人均总预算（不含大交通）
  preferences: string[];   // 偏好标签
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
  dailyCostCny: number;    // 人均当天花费（validate 回填）
}

export interface Plan {
  city: string;
  summary: string;
  days: PlanDay[];
  totalCostCny: number;
  tips: string[];          // 预约/避坑提示
  warnings: string[];      // 体检结果：未验真 POI / 通勤偏长 / 节奏 / 预算
  verified: boolean;       // 是否走了真实高德数据（false = mock 模式）
}
