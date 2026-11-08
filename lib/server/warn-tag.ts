// 体检预警分类：把一条长文本预警归成一个短标签，让用户一眼扫读
// 「这行程有哪几类问题」（绕路/预算/未验真…）。
//
// 做法是按预警文本里的**特征短语**匹配——这些短语由 validate.ts 生成、稳定。
// 匹配不上返回 null：优雅降级（不加假标签），也避免把改过的文案错归类。
// 纯函数、client 安全（PlanView 客户端组件要用）。

export function warnTag(w: string): string | null {
  if (w.includes("可能存在绕路")) return "绕路";
  if (w.includes("节奏上限") || w.includes("偏松")) return "节奏";
  if (w.includes("超出预算") || w.includes("预算较为宽松")) return "预算";
  if (w.includes("个不同区域")) return "分散";
  // 本轮新增（可执行性）：时间轴接不上 / 营业时间与闭馆日。
  // 放在「未验真」之前？不需要——这两类文案不含「未在高德检索到」，互不干扰。
  // 只认「时间接不上」：营业时间 outside 类警告也会建议「一键顺延」，
  // 若把「一键顺延」也算时间轴，它会被错标成时间轴并路由到 adjust（实测踩坑）。
  if (w.includes("时间接不上")) return "时间轴";
  if (
    w.includes("闭馆") ||
    w.includes("才开门") ||
    w.includes("营业时间") ||
    w.includes("暂停开放")
  )
    return "营业";
  // 覆盖必须排在「未在高德检索到」之前：境外预警文案里同时含「境外」和
  // 「未在高德检索到」，先匹配未验真会把它误判成单点未命中（实测踩过）。
  if (w.includes("境外")) return "覆盖";
  if (w.includes("未在高德检索到")) return "未验真";
  if (w.includes("重点活动")) return "活动";
  if (w.includes("高德服务波动") || w.includes("通勤估算失败")) return "系统";
  return null;
}
