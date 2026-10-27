import type { TripEventRecord } from "./store/types";

// ============================================================
// 克隆计数：分享页的「社交证明」
//
// 为什么用事件表而不是给 Plan 加计数字段：`trip_cloned` 事件本来就在
// EVENT_NAMES 里（度量闭环的漏斗一环），只是克隆路由一直没有写它——
// 计数与看板复用同一份数据，不需要 schema 迁移，也不会有「两处计数不一致」。
//
// 口径：提交克隆即计数（与漏斗口径一致：trip_cloned = 用户点了克隆）。
// 没有记录时返回 0，UI 整块不渲染——不编「已有 999 人克隆」。
// ============================================================

/** 纯函数：统计某份行程被克隆的次数（可单测，不碰存储） */
export function countClones(events: readonly TripEventRecord[], shareId: string): number {
  let n = 0;
  for (const e of events) {
    if (e.name === "trip_cloned" && e.shareId === shareId) n += 1;
  }
  return n;
}
