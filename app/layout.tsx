import type { Metadata, Viewport } from "next";
import "./globals.css";
import { MotionPref } from "@/components/MotionPref";

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
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

// 根布局只提供 <html>/<body> 与动效降级开关，不再挂营销站点头尾。
//
// 产品面和营销面是两种壳（见 app/(app)/layout.tsx 与 app/(marketing)/layout.tsx）：
// - 产品壳：紧凑顶栏（我的行程 / 新建）+ 页面内容，没有营销导航与页脚；
// - 营销壳：SiteHeader + SiteFooter，只在 /about 使用。
//
// 之前的错误：把「企业级应用外壳」实现成了全站营销导航 + 页脚，于是分享页、
// 行中页、结果页都像官网子页面——这是「像公司官网」的结构性原因。
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <MotionPref>{children}</MotionPref>
      </body>
    </html>
  );
}
