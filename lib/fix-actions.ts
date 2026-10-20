import type { Plan, PlanDay, PlanInput } from "./types";

// ============================================================
// 体检「一键修复」：把一条预警翻译成一次「AI 改一天」。
//
// 产品定位：体检以前只报告问题（「第 2 天节奏超 10 小时」），用户得自己
// 想办法、自己组织一句指令、还要担心说错话。这里把「可修的问题」和
// 「给模型的那句话」都收敛到服务端：
//   suggestFix      —— 前端只渲染按钮（client-safe 纯函数，PlanView 直接用）
//   fixInstruction  —— 服务端把修复意图翻成**模板化指令**，不接受用户自由输入
//
// 为什么必须是模板而不是用户输入：指令最终会拼进 LLM prompt，自由输入就是
// 注入面（用户可以让模型「忽略前面的硬约束」）。模板化后指令只由这里的常量
// 决定，且天然满足路由层的字符白名单与 refine 的 sanitizeInstruction。
//
// 诚实红线：
// 1) 修不了的问题（未验真/境外/系统波动/硬约束漏排/时间轴）**不返回按钮**，
//    不提供「点了也没用」的假动作。
// 2) 只改一天：所有指令都以「第 N 天」开头，refine 的 prompt 也只允许模型
//    输出那一天；其余天在结构上引用原对象，模型没有机会重写。
// 3) 不诱导删硬约束：模板里不出现 delete 类动词（删/去掉/取消/不要/别去/移除），
//    也不点名任何必游地/活动名称；必游地与活动由 refine 的 requiredKeeps 兜底。
//
// 本文件必须保持 client-safe：不 import server-only 模块（PlanView 客户端组件
// 会 import suggestFix）。阈值与 validate.ts 同源，那边是 server-only 不能直接
// 复用，这里复制常量并注明同步义务（tests/lib/fix-actions.test.ts 钉住行为）。
// ============================================================

/** 可一键修复的问题类型（与 refine 路由的 fixKind 枚举同源，路由直接用 FIX_KINDS） */
export const FIX_KINDS = [
  "transit",
  "pace",
  "budget-over",
  "budget-under",
  "rain",
  "hours",
] as const;

export type FixKind = (typeof FIX_KINDS)[number];

/** 一条预警对应的修复建议：前端据此渲染「一键修复」按钮 */
export interface WarningFix {
  fixKind: FixKind;
  /** 作用在哪一天；预算类问题是全局的（day=null，服务端按花费自动挑一天） */
  day: number | null;
  /** 按钮短文案（如「减轻节奏」） */
  label: string;
  /** 一句话说明点了会发生什么（按钮 title/aria-label 用） */
  hint: string;
}

/**
 * fixInstruction 数据不足/不再适用（映射 HTTP 422）。
 *
 * 典型：预算类但每天都是 0 元；节奏类但当天已回到合理区间（预警是旧页面的）。
 * 与「未知异常」严格区分：这是「这份行程当前没有可执行的一键修复」，用户
 * 仍可改用「重排这一天」。
 */
export class FixDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixDataError";
  }
}

// ---------- 识别预警 ----------

/** 从预警文案里取「第 N 天」（validate/weather 的文案统一用半角空格分隔数字） */
function dayOf(warning: string): number | null {
  const m = warning.match(/第\s*(\d+)\s*天/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** 坏天气判定：与 lib/weather.ts 的 isBadWeather 同口径（那边 server-only，客户端只能内联） */
const BAD_WEATHER_RE = /雨|雪|雹|沙|尘|雾|霾/;

/**
 * 根据一条体检预警判断「能不能一键修、怎么修」。
 *
 * 识别规则必须与 validate.ts / weather.ts 的**文案特征短语**对齐（与
 * lib/warn-tag.ts 是同一套思路）：文案是稳定契约，匹配不上就返回 null ——
 * 优雅降级成「不可自动修」，而不是给一个语义不明的按钮。
 *
 * 顺序即优先级，几个必须靠顺序解决的坑：
 * 1) 「通勤估算失败（高德服务波动）」也含「通勤」——系统类必须先排除，
 *    否则会被当成「绕路」给用户一个点了必然失败的修复。
 * 2) 「时间接不上」是确定性顺延（/api/plan/adjust），不是 LLM 改一天。
 * 3) 营业时间分两类，只有一类该出按钮：
 *    - 闭馆/暂停开放 → 这个点当天去不了，换掉它是合理修复（hours）。
 *    - 「才开门 / 关门早于安排 / 营业时间对不上」→ 问题是**时间排错**，正确
 *      修复是确定性顺延（adjust retime）或用户自己挪；让模型「换一个点」既
 *      不能保证修好，还可能把本来合适的点换掉。给修不好的按钮比没有按钮更
 *      伤信任（Lead 2026-10-20 明确），所以返回 null。
 */
export function suggestFix(warning: string): WarningFix | null {
  const w = String(warning ?? "").trim();
  if (!w) return null;
  const day = dayOf(w);

  // ---- 1) 确定性/不可自动修：先排除，避免被后面的宽泛特征吞掉 ----
  // 时间轴接不上：修复是「一键顺延」（确定性重排、不烧模型），不走这里
  if (w.includes("时间接不上")) return null;
  // 未验真 / 境外无覆盖：这是数据边界，不是行程安排问题——重排一天也修不掉
  if (w.includes("未在高德检索到") || w.includes("境外") || w.includes("无 POI 覆盖")) {
    return null;
  }
  // 高德服务波动 / 通勤估算失败：上游数据缺失，重排只是猜
  if (w.includes("高德服务波动") || w.includes("通勤估算失败")) return null;
  // 硬约束漏排/错排、住所未体现：重排一天也不能保证模型这次不遗漏——不假装能修
  if (w.includes("必游地") || w.includes("重点活动") || w.includes("住所")) return null;

  // ---- 2) 营业时间「对不上」：时间排错，换点修不好 → 不给按钮 ----
  // 「才开门」「关门早于安排」「可能进不去」都是同一类：到达/离开时间不在
  // 营业窗口内。确定性顺延（/api/plan/adjust）或用户手动挪才是真修复。
  if (
    w.includes("才开门") ||
    (w.includes("营业时间") && (w.includes("可能进不去") || w.includes("关门")))
  ) {
    return null;
  }

  // ---- 3) 闭馆 / 暂停开放：这个点当天去不了，换掉它合理 → hours ----
  if (w.includes("闭馆") || w.includes("暂停开放") || w.includes("营业时间")) {
    if (day === null) return null;
    return {
      fixKind: "hours",
      day,
      label: "避开闭馆",
      hint: "让 AI 换掉当天闭馆/暂停开放的景点，改成当天开放的同类型景点",
    };
  }

  // ---- 4) 其余「一键顺延」提示：确定性重排，不是 LLM ----
  if (w.includes("一键顺延")) return null;

  // ---- 4) 绕路：通勤偏长 或 区域分散（validate 的「分散」文案含「通勤」）----
  if (w.includes("可能存在绕路") || w.includes("通勤")) {
    if (day === null) return null;
    return {
      fixKind: "transit",
      day,
      label: "收拢动线",
      hint: "让 AI 把当天景点收拢到同一区域，减少跨区折返",
    };
  }

  // ---- 5) 节奏：超上限要减轻，偏松要充实（同一个 fixKind，模板在服务端按当天实际数据选）----
  if (w.includes("节奏上限")) {
    if (day === null) return null;
    return {
      fixKind: "pace",
      day,
      label: "减轻节奏",
      hint: "让 AI 减少 1 个景点，把当天安排压回节奏上限内",
    };
  }
  if (w.includes("偏松")) {
    if (day === null) return null;
    return {
      fixKind: "pace",
      day,
      label: "充实一点",
      hint: "让 AI 给当天补 1 个同区域景点，把安排充实一些",
    };
  }

  // ---- 6) 预算：全局问题，day 由服务端按花费最高/最低那天自动挑 ----
  if (w.includes("超出预算")) {
    return {
      fixKind: "budget-over",
      day: null,
      label: "压预算",
      hint: "让 AI 把人均花费最高的一天压到约 75%，优先保留体验项目",
    };
  }
  if (w.includes("预算较为宽松")) {
    return {
      fixKind: "budget-under",
      day: null,
      label: "加体验",
      hint: "让 AI 给花费最低的一天增加体验或升级餐厅，把预算用起来",
    };
  }

  // ---- 7) 天气：预报有雨雪等坏天气且有室外景点 ----
  if (w.includes("预报") && BAD_WEATHER_RE.test(w)) {
    if (day === null) return null;
    return {
      fixKind: "rain",
      day,
      label: "改室内",
      hint: "让 AI 把当天的室外景点换成同区域室内景点，保留用餐",
    };
  }

  return null;
}

// ---------- 模板化指令 ----------

// 节奏阈值：与 lib/validate.ts 的 PACE_DAY_MIN / LOOSE_DAY_MIN **必须同值**。
// 那边 import "server-only" 不能共享，改动时两边一起改（本文件测试钉住行为）。
const PACE_CAP_MIN: Record<NonNullable<PlanInput["pace"]>, number> = {
  relaxed: 8 * 60,
  balanced: 10 * 60,
  packed: 13 * 60,
};
const LOOSE_DAY_MIN = 5 * 60;

/** 预算类目标：超支把最高的那天压到 75%；宽松按 validate 的 80% 阈值反推目标 */
const BUDGET_OVER_RATIO = 0.75;
const BUDGET_TARGET_RATIO = 0.8;

/** 当天人均花费：以 spots 累加为准（与 validate.finalizePlan 的回填同源，不信任缓存字段） */
function dayCost(day: PlanDay): number {
  return day.spots.reduce((s, x) => s + (Number.isFinite(x.costCny) ? x.costCny : 0), 0);
}

/** 当天净时长 = 停留 + 已知通勤（与 validate 的节奏口径一致；通勤未知按 0 算，不猜） */
function activeMinutes(day: PlanDay): number {
  const stay = day.spots.reduce(
    (s, x) => s + (Number.isFinite(x.durationMin) ? x.durationMin : 0),
    0,
  );
  return stay + (Number.isFinite(day.transitMin) ? day.transitMin : 0);
}

/** 花费最高/最低的那天（相同花费取靠前的天，保证确定性） */
function pickCostDay(plan: Plan, want: "max" | "min"): PlanDay {
  if (!plan.days.length) {
    throw new FixDataError("这份行程没有可调整的天，无法一键修复；请刷新页面后重试");
  }
  return plan.days.reduce((best, d) => {
    const cur = dayCost(d);
    const base = dayCost(best);
    return want === "max" ? (cur > base ? d : best) : (cur < base ? d : best);
  });
}

/** 取目标天：找不到时回退第 1 天（分日流的骨架永远从第 1 天开始） */
function resolveDay(plan: Plan, requested: number): PlanDay {
  if (!plan.days.length) {
    throw new FixDataError("这份行程没有可调整的天，无法一键修复；请刷新页面后重试");
  }
  return (
    plan.days.find((d) => d.day === requested) ??
    plan.days.find((d) => d.day === 1) ??
    plan.days[0]
  );
}

/**
 * 这次修复实际作用在哪一天。
 *
 * 预算类是全局问题：**忽略请求里的 day**，按花费最高（超支）/最低（宽松）
 * 自动挑一天（与「选当天人均花费最高的那天」契约一致）。其余修复都作用在
 * 预警点名的当天，越界时回退第 1 天。
 *
 * 路由层先校验请求 day 存在（400），这里是第二道防线：旧页面/并发改动的
 * 残留不会把指令落到不存在的一天。
 */
export function resolveFixDay(plan: Plan, fixKind: FixKind, day: number): number {
  if (fixKind === "budget-over") return pickCostDay(plan, "max").day;
  if (fixKind === "budget-under") return pickCostDay(plan, "min").day;
  return resolveDay(plan, day).day;
}

/**
 * 把修复意图翻成「给模型的一天指令」。
 *
 * 全部模板化：只由 fixKind + 当天的真实数据决定，**不含任何用户输入**，
 * 因此天然通过 refine 路由的字符白名单与 sanitizeInstruction（≤100 字、
 * 无引号/花括号/换行）。测试逐条钉住了模板原文，Lead 的 e2e/文档以那份为准。
 *
 * 只改一天、保留硬约束、不诱导删点：模板里没有 delete 类动词，也不点名
 * 必游地/活动名；refine 侧还会用 requiredKeeps 再兜一层。
 *
 * @throws FixDataError 数据不足或问题已不存在（路由映射 422，给出行动建议）
 */
export function fixInstruction(
  plan: Plan,
  input: PlanInput,
  fixKind: FixKind,
  day: number,
): string {
  // 先把「这次实际改哪天」定下来（预算类忽略请求 day，按花费自动挑），
  // 模板里的天号与后面的数据取值必须来自同一天，否则指令会说「第 3 天」
  // 却按第 1 天的花费算目标。
  const d = resolveFixDay(plan, fixKind, day);
  const target = plan.days.find((x) => x.day === d) ?? plan.days[0];

  switch (fixKind) {
    case "transit":
      return `第${d}天景点收拢到同一区域，减少跨区折返，当天通勤控制在1小时内`;

    case "rain":
      return `第${d}天有雨，把室外景点换成同区域的室内景点，保留用餐安排`;

    case "hours":
      return `第${d}天避开闭馆的景点，换成当天开放的同类型景点，保留用餐`;

    case "pace": {
      const cap = PACE_CAP_MIN[input.pace ?? "balanced"];
      const active = activeMinutes(target);
      // 模板服务端二选一：不看预警文案（接口只传 fixKind），而是按当天**当前**
      // 实际负载判断该减轻还是该充实——用户手里的页面可能已经旧了。
      if (active > cap) {
        return `第${d}天减少1个景点，保证21点前结束，节奏按适中安排`;
      }
      if (active < LOOSE_DAY_MIN) {
        return `第${d}天增加1个同区域的代表性景点，把当天安排充实到8小时左右`;
      }
      // 落在合理区间 = 问题已经不存在（或页面太旧）。不硬造一次改动，诚实告知。
      const hours = Math.round((active / 60) * 10) / 10;
      throw new FixDataError(
        `第 ${d} 天当前安排约 ${hours} 小时，已在合理节奏区间内，无需再调整；如仍想换安排可改用「重排这一天」`,
      );
    }

    case "budget-over": {
      const cost = dayCost(target);
      if (cost <= 0) {
        throw new FixDataError(
          "这份行程没有可压缩的具体花费（每天都是 0 元），无法按预算一键压缩；可改用「重排这一天」",
        );
      }
      const targetCost = Math.max(1, Math.round(cost * BUDGET_OVER_RATIO));
      return `第${d}天人均花费控制在${targetCost}元以内，优先保留体验项目`;
    }

    case "budget-under": {
      if (!Number.isFinite(input.budget) || input.budget <= 0) {
        throw new FixDataError(
          "这份行程没有有效的人均预算，无法按预算一键提升花费；可改用「重排这一天」",
        );
      }
      const cost = dayCost(target);
      const total = plan.days.reduce((s, x) => s + dayCost(x), 0);
      // 目标：把当天花费抬到「总花费补到预算 80%（validate 的宽松阈值）」所需，
      // 至少也涨 30%/50 元——否则指令等于「提高到原值」，是句空话。
      const gap = Math.round(input.budget * BUDGET_TARGET_RATIO) - total;
      const floor = Math.max(Math.round(cost * 0.3), 50);
      const raisedCost = cost + Math.max(gap, floor);
      return `第${d}天增加1项有代表性的体验或升级餐厅，把当天花费提高到约${raisedCost}元`;
    }

    default: {
      // 穷举保护：新增 FixKind 时这里编译期报错，避免「识别到了却没有模板」
      const exhaustive: never = fixKind;
      throw new FixDataError(`不支持的修复类型：${String(exhaustive)}`);
    }
  }
}
