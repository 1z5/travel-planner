import type { Metadata } from "next";
import { HandoffDesk } from "@/components/HandoffDesk";

// 产品的新第一入口：不是生成，也不是体检，而是「出发前把 AI 说的交接成自己确认过的」。
// 整页零接口、零账号、零落库；服务端只负责把这段静态 HTML 送出去。
export const metadata: Metadata = {
  title: "出发前交接单 — 行程规划师",
  description:
    "把 ChatGPT、小红书或朋友发来的行程原样贴进来，逐条说清哪些你核过、哪些先信着，带走一张可离线复算的交接单。不上传、不评分、不担保。",
};

export default function HandoffPage() {
  return (
    <main className="container">
      <HandoffDesk />
    </main>
  );
}
