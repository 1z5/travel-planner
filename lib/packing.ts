import type { Plan, PlanSpot } from "./types";

// ============================================================
// 出行准备包（client-safe 纯函数）：从这份行程推导「出发前要带什么」。
//
// 与市面上「通用打包清单」的区别（产品红线）：
// - **每一项都必须有来源**：来自哪个行程点 / 哪一天 / 哪条出发前提醒。
//   没有依据的项不出现——不塞「换洗内衣、充电器」这种凑数项。
// - 不猜天气：本模块不联网，天气未知时 UI 明确降级说明，
//   不编造「今天有雨，带伞」（那不是推导，是假装知道）。
// - 规则可解释：每条 item 都带 reason（人话依据）与 source（可溯源）。
//
// 证据从哪来（全部是行程 JSON 里真实存在的字段）：
// 1. `rainBackup` 是按 schema 必填于「室外景点」的雨天备选——有它 = 室外；
// 2. `period === "evening"` = 晚间有行程（导航耗电）；
// 3. 点位名称里的山地/步道特征词 = 台阶/湿滑风险；
// 4. `tips` 里的「预约 / 实名」= 证件与预约码需求；
// 5. `days.length >= 3` = 需要按天数备药与换洗。
// ============================================================

export interface PackingItem {
  /** 物品名（短、可扫读） */
  label: string;
  /** 为什么带（人话依据） */
  reason: string;
  /** 溯源：来自行程的哪个点 / 哪天 / 哪条提示（必填） */
  source: string;
  /** 分组：证件 / 衣物 / 装备 / 健康 */
  group: "document" | "clothing" | "gear" | "health";
}

/** 天气未接入时的降级说明（UI 必须展示，不假装知道天气） */
export const PACKING_NO_WEATHER_NOTE = "未接入实时天气：本清单不含雨具建议，出发前请再查一次天气。";

/** 山地 / 台阶类特征词（从点位名称推导，证据可被用户看到） */
const TERRAIN_HINT = /(山|峰|岭|岩|峡|谷|古道|徒步|长城|栈道|湿地|湖|岛)/;

/** 预约类提示词（从 tips 推导，不编造预约规则） */
const BOOKING_HINT = /(预约|实名|抢票|放票)/;

/** 统一取「第 N 天」的展示文案，避免 UI 里出现 0-based 天数 */
function dayLabel(day: number): string {
  return `第 ${day} 天`;
}

function findOutdoorSpot(plan: Plan): { spot: PlanSpot; day: number } | null {
  for (const d of plan.days ?? []) {
    for (const s of d.spots ?? []) {
      // rainBackup 是室外景点的必填字段（见 lib/types.ts 的注释）：
      // 有雨天备选 = 这个点室外，这是 schema 级证据，不是关键词猜测。
      if (typeof s.rainBackup === "string" && s.rainBackup.trim() !== "") {
        return { spot: s, day: d.day };
      }
    }
  }
  return null;
}

function findTerrainSpot(plan: Plan): { spot: PlanSpot; day: number } | null {
  for (const d of plan.days ?? []) {
    for (const s of d.spots ?? []) {
      if (TERRAIN_HINT.test(s.name) && (s.type === "sight" || s.type === "activity")) {
        return { spot: s, day: d.day };
      }
    }
  }
  return null;
}

function findEveningSpot(plan: Plan): { spot: PlanSpot; day: number } | null {
  for (const d of plan.days ?? []) {
    for (const s of d.spots ?? []) {
      if (s.period === "evening") return { spot: s, day: d.day };
    }
  }
  return null;
}

function findBookingTip(plan: Plan): string | null {
  for (const t of plan.tips ?? []) {
    if (typeof t === "string" && BOOKING_HINT.test(t)) return t;
  }
  return null;
}

/**
 * 从行程推导出发前准备清单。顺序按「先证件、再穿戴、再装备、最后健康」，
 * 与出发前的收拾顺序一致。
 */
export function derivePackingList(plan: Plan): PackingItem[] {
  const items: PackingItem[] = [];

  // 1) 证件与预约码：只有 tips 里真的提到预约/实名才出现
  const bookingTip = findBookingTip(plan);
  if (bookingTip) {
    items.push({
      label: "身份证 + 预约凭证",
      reason: "行程提示里有实名预约要求，现场需要证件与预约码",
      source: `出发前提醒：${bookingTip}`,
      group: "document",
    });
  }

  // 2) 防晒与遮阳：有室外景点（有雨天备选字段）才出现
  const outdoor = findOutdoorSpot(plan);
  if (outdoor) {
    items.push({
      label: "防晒与遮阳",
      reason: "行程含室外景点，白天暴晒时防晒霜/遮阳帽会明显影响体验",
      source: `${dayLabel(outdoor.day)} · ${outdoor.spot.name}（室外景点，有雨天备选）`,
      group: "clothing",
    });
  }

  // 3) 抓地运动鞋：山地/台阶/湿地类点位
  const terrain = findTerrainSpot(plan);
  if (terrain) {
    items.push({
      label: "抓地运动鞋",
      reason: "行程含山地/台阶/湿地类点位，步道与石阶可能湿滑",
      source: `${dayLabel(terrain.day)} · ${terrain.spot.name}`,
      group: "clothing",
    });
  }

  // 4) 充电宝：有晚间行程（导航 + 拍照耗电）
  const evening = findEveningSpot(plan);
  if (evening) {
    items.push({
      label: "充电宝",
      reason: "晚间还有行程点，导航与拍照耗电快",
      source: `${dayLabel(evening.day)} · ${evening.spot.name}（晚间）`,
      group: "gear",
    });
  }

  // 5) 常用药与换洗衣物：行程 ≥3 天（按天数推导，不是通用清单）
  const days = Array.isArray(plan.days) ? plan.days.length : 0;
  if (days >= 3) {
    items.push({
      label: "常用药与换洗衣物",
      reason: `行程 ${days} 天，按天数准备换洗与常备药（肠胃药/创可贴）`,
      source: `行程共 ${days} 天（≥3 天）`,
      group: "health",
    });
  }

  return items;
}
