import type { MetadataRoute } from "next";

// PWA manifest：让「行中模式」可以添加到主屏、像 App 一样打开。
//
// 为什么现在做：竞品调研（2026-10）里 Mindtrip 的 App Store 长评点名「行中
// 移动端体验糟、找不到某天行程」——行中是全行业共同短板，而我们的「今日镜头」
// 只差一个「像 App 的入口」。manifest + 离线缓存是最小闭环，不做原生 App。
//
// 图标由 scripts/gen-pwa-icons.mjs 生成（品牌源 SVG → PNG），改品牌色改脚本。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "行程规划师 — 先核验真实世界，再排行程",
    short_name: "行程规划师",
    description: "AI 生成行程前先用高德核验 POI、营业时间、闭馆日与真实通勤，出发前把风险摊开。",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f6f0e4",
    theme_color: "#c2410c",
    lang: "zh-CN",
    categories: ["travel", "navigation", "productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "新建行程", url: "/new" },
      { name: "我的行程", url: "/" },
    ],
  };
}
