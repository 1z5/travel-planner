// 行前倒计时：把「我的行程」从静态列表变成「有时间感的期待」。
//
// 为什么需要：调研结论（D2）——「倒计时 + 行前提醒」是旅行产品最便宜的回访理由
// （Giovex/TripIt 都靠它）。我们已有行程列表，但没有「什么时候出发」的时间感；
// 回访用户看到「距出发 12 天」才会想起回来做行前准备。
//
// 全部基于 tripToday（同一套「今天是不是行程日」口径），不自己另算一套日期逻辑——
// 两套口径迟早会在跨时区/跨天时打架。拿不到合法 startDate 时返回 null（不猜）。

import { tripToday } from "./trip-day";

export interface Countdown {
  /** 展示文案："还有 12 天出发" / "今天出发" / "行程第 2 天" / "行程已结束" */
  text: string;
  /** 语义档位（UI 用它选颜色）：soon 临近 / active 行中 / past 已结束 */
  tone: "soon" | "active" | "past";
}

/**
 * @param startDate 行程首日 "YYYY-MM-DD"（缺失/非法 → null，不猜）
 * @param days      行程天数
 * @param todayIso  今天 "YYYY-MM-DD"（由调用方给，便于测试固定时钟）
 */
export function countdownFor(
  startDate: string | undefined,
  days: number,
  todayIso: string,
): Countdown | null {
  if (!startDate) return null;
  const t = tripToday(startDate, todayIso, days);
  switch (t.kind) {
    case "before":
      // 出发前统一用 soon 档位：文案本身已带天数，UI 不必再按远近分色
      return {
        text: t.daysUntil === 1 ? "明天出发" : `还有 ${t.daysUntil} 天出发`,
        tone: "soon",
      };
    case "during":
      return {
        text: t.dayIndex === 0 ? "今天出发" : `行程第 ${t.dayIndex + 1} 天`,
        tone: "active",
      };
    case "after":
      return { text: "行程已结束", tone: "past" };
    default:
      return null; // unknown：没有合法日期，不显示倒计时
  }
}
