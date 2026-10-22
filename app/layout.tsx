import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const metadata: Metadata = {
  title: "行程规划师 — 先核验真实世界，再排行程",
  description:
    "输入目的地、起止时间、预算和偏好，生成结构化国内城市行程：POI 与营业时间来自高德实时核验，通勤按真实路况计算，体检问题全部摊开。",
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
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
