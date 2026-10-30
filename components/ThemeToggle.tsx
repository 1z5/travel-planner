"use client";

import { useEffect, useRef } from "react";
import { Moon, Sun } from "lucide-react";

// ============================================================
// 主题开关（ATLAS v6）
//
// 三态：auto（无 data-theme，跟随系统）→ light → dark → auto。
// 为什么不用 React state 渲染图标：SSR 拿不到用户偏好，用 state 会在
// 首帧闪一下；这里两个图标都渲染，由 CSS（html[data-theme=dark] /
// prefers-color-scheme）决定显示哪个——零 hydration 抖动。
//
// 切换动效：支持 View Transitions 时从开关位置做圆形揭示
// （2026 年主流做法：Linear / Vercel / Apple 都用这种「光从按钮扩散」）。
// 不支持时直接切换，不影响功能。
// ============================================================

const KEY = "at-theme";
type Theme = "light" | "dark";

function applyTheme(theme: Theme | null) {
  const root = document.documentElement;
  if (theme) {
    root.dataset.theme = theme;
  } else {
    delete root.dataset.theme;
  }
  // 移动端浏览器 UI 的主题色（meta 由服务端给两套 media 值，这里同步手动切换）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", theme === "dark" ? "#05080f" : "#edf1f7");
  }
}

export function ThemeToggle() {
  const btnRef = useRef<HTMLButtonElement>(null);

  // 挂载后同步一次：脚本在 <head> 里已写过 data-theme，这里只负责把
  // 「当前状态」补到可访问名上（无 JS 时按钮仍可点，标签兜底为通用文案）。
  useEffect(() => {
    const stored = window.localStorage.getItem(KEY);
    const current =
      stored === "light" || stored === "dark"
        ? stored
        : document.documentElement.dataset.theme === "dark"
          ? "dark"
          : "light";
    btnRef.current?.setAttribute("data-current", current);
  }, []);

  function cycle() {
    const root = document.documentElement;
    const stored = window.localStorage.getItem(KEY);
    // auto → light → dark → auto
    const next: Theme | null = !stored ? "light" : stored === "light" ? "dark" : null;

    const commit = () => {
      if (next) window.localStorage.setItem(KEY, next);
      else window.localStorage.removeItem(KEY);
      applyTheme(next);
    };

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!document.startViewTransition || reduce) {
      commit();
      return;
    }

    // 圆形揭示的圆心 = 按钮中心（视口坐标 → 百分比，供 clip-path 用）
    const r = btnRef.current?.getBoundingClientRect();
    root.style.setProperty(
      "--at-theme-x",
      `${(((r?.left ?? window.innerWidth) + (r?.width ?? 0) / 2) / window.innerWidth) * 100}%`,
    );
    root.style.setProperty(
      "--at-theme-y",
      `${(((r?.top ?? 0) + (r?.height ?? 0) / 2) / window.innerHeight) * 100}%`,
    );
    root.classList.add("at-theme-anim");
    const vt = document.startViewTransition(commit);
    void vt.finished.finally(() => root.classList.remove("at-theme-anim"));
  }

  return (
    <button
      ref={btnRef}
      type="button"
      className="at-theme-toggle"
      onClick={cycle}
      aria-label="切换主题：跟随系统 / 浅色 / 深色"
      title="切换主题"
    >
      <Sun size={17} aria-hidden="true" className="at-theme-icon-sun" />
      <Moon size={17} aria-hidden="true" className="at-theme-icon-moon" />
    </button>
  );
}
