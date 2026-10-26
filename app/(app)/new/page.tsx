import type { Metadata } from "next";
import { HomeClient } from "@/app/home-client";

// 新建行程：产品态的生成页（不再带 hero / 信任条 / 营销区块）。
// 生成完成后仍在本页看结果；回「我的行程」入口在顶栏。
export const metadata: Metadata = {
  title: "新建行程 — 行程规划师",
  description: "输入目的地、时间、预算和偏好，生成一份经真实世界核验的行程。",
};

export default function NewTripPage() {
  // 这里**不要**再给 HomeClient 套 Suspense 边界：它曾因为 useSearchParams
  // 只能 client-only bailout（fallback=null → 首屏 HTML 里连表单都没有，用户
  // 要等整包 JS hydrate 才看到界面）。深链改为挂载后读 window.location.search，
  // 现在整个表单可以随 SSG 预渲染进首屏 HTML（2026-10 审计实测修复）。
  return <HomeClient />;
}
