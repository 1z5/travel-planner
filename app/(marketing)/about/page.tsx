import type { Metadata } from "next";
import Link from "next/link";
import { LandingSections } from "@/app/landing-sections";

// 营销页：只服务「第一次了解产品」的访客。
// 产品入口是 /（我的行程），这里不承担工具职责。
export const metadata: Metadata = {
  title: "为什么是行程规划师 — 先核验真实世界，再排行程",
  description:
    "市面上的 AI 行程靠模型记忆编 POI 和营业时间；我们先取高德真实事实再排行程，体检问题全部摊开。",
};

export default function AboutPage() {
  return (
    <main className="about-page">
      <section className="about-hero">
        <div className="container about-hero-inner">
          <p className="about-eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            事实先行 · 生成前先核验真实世界
          </p>
          <h1 className="about-title">
            每一份行程，
            <br />
            都经得起核验
          </h1>
          <p className="about-lede">
            先取真实世界的事实——POI 是否存在、几点开门、哪天闭馆、两站之间要走多久——
            再让模型在已核验的清单上排行程。体检是兜底，不是质检员。
          </p>
          <div className="about-actions">
            <Link href="/new" className="btn btn-primary">
              新建一份行程
            </Link>
            <Link href="/" className="btn btn-ghost">
              进入我的行程
            </Link>
          </div>
          <p className="about-facts">
            <Link href="/cities" className="about-cities-link">
              按城市看模板（12 城 · 3/4/5 天）→
            </Link>
          </p>
          <p className="about-facts">
            3 城真实高德 key 实测（2026-10）· 逐项标注核验状态 · 1,900+ 项自动化检查 ·
            数据来自高德开放平台
          </p>
        </div>
      </section>

      <div className="container about-sections">
        <LandingSections />
      </div>
    </main>
  );
}
