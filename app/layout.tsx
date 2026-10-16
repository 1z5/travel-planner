import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "行程规划师 - AI 智能旅行规划",
  description: "输入目的地、起止时间、预算和偏好，生成结构化国内城市行程，POI 验真 + 绕路体检",
};

// 移动端的关键声明。缺了它，手机浏览器会按 980px 宽度渲染再整体缩放，
// 下面 globals.css 里所有的 @media (max-width: 640px) 都不会触发。
// viewportFit: "cover" 配合 CSS 的 env(safe-area-inset-*) 适配刘海屏。
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
