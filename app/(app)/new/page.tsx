import type { Metadata } from "next";
import { HomeClient } from "@/app/home-client";

// 新建行程：产品态的生成页（不再带 hero / 信任条 / 营销区块）。
// 生成完成后仍在本页看结果；回「我的行程」入口在顶栏。
export const metadata: Metadata = {
  title: "新建行程 — 行程规划师",
  description: "输入目的地、时间、预算和偏好，生成一份经真实世界核验的行程。",
};

export default function NewTripPage() {
  return <HomeClient />;
}
