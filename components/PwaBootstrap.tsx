"use client";

import { useEffect, useState } from "react";
import { useOffline } from "next/offline";
import { CloudOff } from "lucide-react";

// ============================================================
// PWA 引导：注册离线 Service Worker + 断网提示
//
// 为什么放在客户端组件里：SW 只能在浏览器注册；而「当前离线」的提示用
// next/offline 的 useOffline（需 next.config.ts 开 experimental.useOffline）。
//
// 两条刻意：
// 1. **只在生产注册**：dev 下注册 SW 会让 HMR/热更新行为变得难以预测
//    （缓存壳子拦截导航），踩过的坑不值得再踩。
// 2. **提示常驻但不打扰**：断网是行中场景的高频事件（地铁/境外），顶部一条
//    可关闭的提示条说清「当前离线，已显示的是最后一次缓存」——不弹窗、不阻断。
// ============================================================

function registerServiceWorker() {
  if (process.env.NODE_ENV !== "production") return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // 页面 load 后再注册：避免和首屏抢带宽（行中首屏要快）
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // 注册失败（隐私模式/不支持）静默降级：PWA 是增强，不是门槛
    });
  });
}

export function PwaBootstrap() {
  const offline = useOffline();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    registerServiceWorker();
  }, []);

  if (!offline || dismissed) return null;

  return (
    <div className="offline-banner" role="status">
      <CloudOff size={15} aria-hidden="true" />
      <span>当前离线：显示的是最后一次加载的内容，恢复联网后自动继续。</span>
      <button type="button" onClick={() => setDismissed(true)} aria-label="关闭离线提示">
        ×
      </button>
    </div>
  );
}
