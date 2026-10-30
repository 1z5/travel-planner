import type { Metadata } from "next";
import Link from "next/link";
import { LandingSections } from "@/app/landing-sections";

// 营销页：只服务「第一次了解产品」的访客。
// 产品入口是 /（我的行程），这里不承担工具职责。
//
// ATLAS v6：Hero = 左侧主张（大号无衬线 + 网格图纸底）+ 右侧产品预览玻璃面板。
// 预览面板是**示例界面**（aria-hidden + 面板内注明「非真实行程」），
// 不冒充真实核验结果——诚实口径优先于视觉。
export const metadata: Metadata = {
  title: "为什么是行程规划师 — 先核验真实世界，再排行程",
  description:
    "市面上的 AI 行程靠模型记忆编 POI 和营业时间；我们先取高德真实事实再排行程，体检问题全部摊开。",
};

export default function AboutPage() {
  return (
    <main className="about-page">
      <section className="about-hero at-grid-bg">
        <div className="container about-hero-inner">
          <div className="about-hero-copy">
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

          <aside className="about-preview product-preview" aria-hidden="true">
            <div className="pp-bar">
              <span className="pp-title">成都 · 3 天</span>
              <span className="pp-status">
                <span className="pp-status-dot" />
                已核验
              </span>
            </div>
            <div className="pp-meta">
              <span>DAY 1–3</span>
              <span className="pp-sep" />
              <span>POI · 营业时间 · 通勤</span>
            </div>
            <ul className="pp-days">
              <li>
                <span className="pp-dayno">D1</span>
                <span className="pp-theme">老城步行 + 一顿晚饭</span>
                <span className="pp-count">3 站</span>
              </li>
              <li>
                <span className="pp-dayno">D2</span>
                <span className="pp-theme">近郊 + 半天机动</span>
                <span className="pp-count">2 站</span>
              </li>
              <li>
                <span className="pp-dayno">D3</span>
                <span className="pp-theme">博物馆 + 轻松收尾</span>
                <span className="pp-count">2 站</span>
              </li>
            </ul>
            <div className="pp-foot">
              <span className="pp-note">示例界面 · 非真实行程</span>
              <span className="pp-note">核验状态以生成结果为准</span>
            </div>
          </aside>
        </div>
      </section>

      <div className="container about-sections">
        <LandingSections />
      </div>
    </main>
  );
}
