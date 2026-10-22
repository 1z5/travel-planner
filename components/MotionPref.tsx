"use client";

import { MotionConfig } from "framer-motion";
import type { ReactNode } from "react";

// 全局动效偏好：尊重系统的「减少动效」设置。
//
// 为什么放在根布局：framer-motion 的入场动画（hero / 海报 / 等待进度）
// 分散在多个客户端组件里，逐个包 MotionConfig 既重复又容易漏。这里用
// 一个 provider 统一设置 reducedMotion="user"——系统开了「减少动效」时
// framer-motion 会自动跳过位移动画（只保留 opacity 之类的低成本变化），
// 不影响任何布局与业务逻辑。
export function MotionPref({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
