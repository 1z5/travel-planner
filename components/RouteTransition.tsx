"use client";

import { ViewTransition } from "react";
import type { ReactNode } from "react";

// ============================================================
// 路由级转场（React 19.3 `<ViewTransition>` + 浏览器 View Transitions API）
//
// 为什么需要它：Next App Router 的路由切换默认是「瞬间替换」，从首页点进
// 工作台时会有一帧空白式的硬跳。React 19.3 把 ViewTransition 转正，且
// Next 16 的导航本身就是 Transition，所以**零配置**就能拿到原生转场。
//
// 边界（重要）：
// - 只包裹页面内容，不包裹顶栏（顶栏是持久的，不该跟着淡出）；
// - 只做 6px 位移 + 交叉淡入，不做花哨的共享元素 morph——跨路由 morph 需要
//   两端同名元素，页面数据是异步加载的，做不到就退化成普通切换；
// - 不支持该 API 的浏览器（或开启「减少动效」）时，React 会跳过动画，
//   页面行为完全不变（这是 CSS/React 双方的既定降级路径）。
// ============================================================

export function RouteTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition enter="at-route-in" exit="at-route-out" default="none">
      {children}
    </ViewTransition>
  );
}
