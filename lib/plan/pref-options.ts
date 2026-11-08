// 出行偏好白名单（单一事实来源）。
//
// 为什么单独一个文件：这份白名单原来写在 `app/home-client.tsx`（客户端表单），
// 但服务端的「攻略提取」（lib/trip-extract.ts）也要用它校验模型输出——
// 从客户端组件 import 会把 "use client" 的模块拖进服务端，所以下沉成
// client-safe 纯数据模块，两边都从这里取。

export const PREF_OPTIONS = [
  "美食",
  "历史文化",
  "自然风光",
  "Citywalk",
  "博物馆",
  "购物",
  "拍照打卡",
  "小众冷门",
  "亲子友好",
  "夜生活",
] as const;

export type PrefOption = (typeof PREF_OPTIONS)[number];

/** 是否合法偏好值（服务端校验模型输出、客户端过滤深链参数共用） */
export function isPrefOption(value: string): value is PrefOption {
  return (PREF_OPTIONS as readonly string[]).includes(value);
}
