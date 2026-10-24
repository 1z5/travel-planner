// 前端埋点：fire-and-forget。
//
// 为什么不用 next/third-parties 或 analytics SDK：这个项目的原则是「不猜不假装」，
// 也包括**不引入看不见的数据通道**。自建 /api/events 只收 shareId/城市/第几天/
// 少量 meta（见 lib/metrics.ts 的隐私口径），用户可在隐私政策里读到，我们也能
// 在看板里复现。SDK 会把数据送到我们控制不了的地方。
//
// 失败静默：navigator.sendBeacon 不可用或请求失败都不影响用户操作；
// 卸载时用 sendBeacon（比 fetch 更可能在页面关闭前送达）。

export type TrackName = "plan_opened" | "today_opened";

/** 上报一个产品事件（不 await、不抛错） */
export function track(name: TrackName, payload: { shareId?: string; city?: string; day?: number }) {
  try {
    const body = JSON.stringify({ name, ...payload });
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      navigator.sendBeacon("/api/events", new Blob([body], { type: "application/json" }));
      return;
    }
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 埋点失败不影响主流程 */
  }
}
