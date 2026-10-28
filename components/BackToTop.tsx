"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";

// ============================================================
// 回到顶部浮钮
//
// 为什么需要：行程页（分享页/工作台规划镜头）很长（500px 宽实测 1 万+ px），
// 用户看完底部提醒想回顶部看预算/概览时必须长滑。固定右下角提供一键返回，
// 与吸顶页内导航（TOC）互补：TOC 负责「跳到某一段」，浮钮负责「回顶」。
//
// 两个细节：
// 1) 只在滚动超过 600px 才出现——首屏就有浮钮会挡内容、也没有必要性；
// 2) scroll 监听只做「布尔值变化时才 setState」，避免每帧触发渲染。
// ============================================================

const VISIBLE_AFTER_PX = 600;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function BackToTop() {
  const [visible, setVisible] = useState(false);
  const visibleRef = useRef(false);

  useEffect(() => {
    const onScroll = () => {
      const next = window.scrollY > VISIBLE_AFTER_PX;
      // 只在跨过阈值时更新状态：滚动事件高频，别每帧 setState
      if (next !== visibleRef.current) {
        visibleRef.current = next;
        setVisible(next);
      }
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!visible) return null;

  return (
    <button
      type="button"
      className="back-to-top"
      aria-label="回到顶部"
      title="回到顶部"
      onClick={() => {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      }}
    >
      <ArrowUp size={18} aria-hidden="true" />
    </button>
  );
}
