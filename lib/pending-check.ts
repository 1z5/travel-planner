// 首页粘贴框 → /check 的文本中转键（client-safe，纯常量）。
// 为什么用 sessionStorage 而不是 URL query：一段行程动辄几百上千字，塞进
// query 会被浏览器/代理截断，还会把别人的行程留在历史记录和分享链接里。
export const PENDING_CHECK_TEXT_KEY = "tp.pending-check.v1";
