import type { Metadata, Viewport } from "next";
import "./globals.css";
// ATLAS v6 覆盖层：顺序有意义——tokens 必须最先（后面全部引用它），
// 分片按「基础 → 壳 → 页面」排；同一选择器后写者胜，所以分片永远在 base 之后。
import "./styles/atlas-tokens.css";
import "./styles/atlas-base.css";
import "./styles/atlas-shell.css";
import "./styles/atlas-home.css";
import "./styles/atlas-workspace.css";
import "./styles/atlas-evidence.css";
import "./styles/atlas-marketing.css";
import { MotionPref } from "@/components/MotionPref";
import { PwaBootstrap } from "@/components/PwaBootstrap";

// metadataBase 让 OG/分享链接生成绝对地址。优先级：
// 1) NEXT_PUBLIC_SITE_URL（自定义域名/正式环境显式配置）
// 2) RENDER_EXTERNAL_URL（Render 自动注入的部署 URL：演示环境零配置也能出对 OG）
// 3) localhost（本地开发兜底）
// openGraph/twitter 的标题与描述在这里统一给默认值，子路由（分享页/报告页）各自覆盖。
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.RENDER_EXTERNAL_URL;
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl ?? "http://localhost:3000"),
  title: "行程规划师 — 先核验真实世界，再排行程",
  description:
    "输入目的地、起止时间、预算和偏好，生成结构化国内城市行程：POI 与营业时间来自高德实时核验，通勤按真实路况计算，体检问题全部摊开。",
  openGraph: {
    type: "website",
    siteName: "行程规划师",
    title: "行程规划师 — 每一份行程，都经得起核验",
    description:
      "先取真实世界的事实（POI / 营业时间 / 闭馆日 / 通勤），再让模型排行程。体检问题全部摊开。",
  },
  twitter: {
    card: "summary_large_image",
    title: "行程规划师 — 每一份行程，都经得起核验",
    description: "先核验真实世界，再排行程。",
  },
};

// 移动端的关键声明。缺了它，手机浏览器会按 980px 宽度渲染再整体缩放，
// 下面 globals.css 里所有的 @media (max-width: 640px) 都不会触发。
// viewportFit: "cover" 配合 CSS 的 env(safe-area-inset-*) 适配刘海屏。
// themeColor 给两套（ATLAS v6 双主题）：浏览器 UI 跟随系统色；手动切换时
// ThemeToggle 会同步改 <meta name="theme-color">。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf1f7" },
    { media: "(prefers-color-scheme: dark)", color: "#05080f" },
  ],
};

// 首帧前同步主题：localStorage 有手动选择就写 data-theme，否则留空跟随系统。
// 必须内联在 <head>（阻塞渲染），否则深色用户会先看到一帧白屏再翻转。
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("at-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?"#05080f":"#edf1f7")}}catch(e){}})();`;

// 根布局只提供 <html>/<body> 与动效降级开关，不再挂营销站点头尾。
//
// 产品面和营销面是两种壳（见 app/(app)/layout.tsx 与 app/(marketing)/layout.tsx）：
// - 产品壳：悬浮玻璃指令条（我的行程 / 主题）+ 页面内容；
// - 营销壳：SiteHeader + SiteFooter，只在 /about 等营销页使用。
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-scroll-behavior="smooth"：Next 16 要求显式声明，否则路由转场时
    // 浏览器会把 html 上的 scroll-behavior: smooth 也带进转场（导致落点抖动），
    // 控制台会告警 missing-data-scroll-behavior。
    <html lang="zh-CN" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <PwaBootstrap />
        <MotionPref>{children}</MotionPref>
      </body>
    </html>
  );
}
