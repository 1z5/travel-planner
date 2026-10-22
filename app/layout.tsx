import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { MotionPref } from "@/components/MotionPref";

// metadataBase 让 OG/分享链接生成绝对地址（部署时用 NEXT_PUBLIC_SITE_URL 覆盖）。
// openGraph/twitter 的标题与描述在这里统一给默认值，子路由（分享页/报告页）各自覆盖。
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
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

// 根布局 = 稳定应用外壳（全站顶栏 + 页脚）+ 页面内容。
// 企业级产品的「壳」必须在所有路由上一致：品牌、导航、数据来源声明
// 不应该随着进入分享页/报告页就消失。
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <MotionPref>
          <SiteHeader />
          {children}
          <SiteFooter />
        </MotionPref>
      </body>
    </html>
  );
}
