import type { Metadata } from "next";
import { TripsHome } from "@/components/TripsHome";

// 产品入口：我的行程。
// 营销故事不在这里——/about 才是「说服陌生人」的地方。
export const metadata: Metadata = {
  title: "我的行程 — AI Travel Companion",
  description: "这台设备上的行程。继续规划、查看或分享。",
};

export default function HomePage() {
  return <TripsHome />;
}
