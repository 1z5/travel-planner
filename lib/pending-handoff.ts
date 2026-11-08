// 首页粘贴框 → /handoff 的文本中转键（client-safe，纯常量）。
// 用 sessionStorage 而不是 URL query：行程原文动辄上千字，塞进 query 会被截断，
// 还会把别人的行程留在浏览器历史和分享链接里。
// 与 /check 的 tp.pending-check.v1 分开：旧链路保持原样，不接线、不互相污染。
export const PENDING_HANDOFF_TEXT_KEY = "tp.pending-handoff.v1";
