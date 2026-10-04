import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "行程规划师 - AI 智能旅行规划",
  description: "输入目的地、天数、预算和偏好，30 秒生成结构化的国内城市行程",
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
