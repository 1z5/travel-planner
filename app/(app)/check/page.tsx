import type { Metadata } from "next";
import { TripCheckDesk } from "@/components/TripCheckDesk";

// 产品的新第一入口：把「手上已有的一份行程」摊开核验。
// 刻意不放进 (marketing) 组——它不是介绍页，是真正干活的工具；
// 也刻意不叫 /verify（那是给开发者贴 JSON 的开放体验台）。
export const metadata: Metadata = {
  title: "验一份行程 — 行程规划师",
  description:
    "把 ChatGPT、小红书或朋友发来的行程贴进来，先看看时间安排接不接得上、有没有重复点位和超预算，再决定要不要改。",
};

export default function CheckPage() {
  return (
    <main className="container">
      <TripCheckDesk />
    </main>
  );
}
