import type { Metadata } from "next";
import Link from "next/link";
import { DEMO_SHOWCASE_SHARE_ID, demoShareHref } from "@/lib/demo/demo-links";

export const metadata: Metadata = {
  title: "关于 AI Travel Companion",
  description: "规划旅程、查看今日安排，提前检查可能影响出行的问题。",
};

export default function AboutPage() {
  return (
    <main className="about-page">
      <header className="about-hero">
        <div className="container about-hero-inner">
          <h1 className="about-title">从计划到下一站</h1>
          <p className="about-lede">
            AI Travel Companion
            是一个可自托管的开源旅行工具。出发前安排路线，旅途中查看今日计划、下一站和导航。
          </p>
          <div className="about-actions">
            <Link href="/new" className="btn btn-primary">
              新建行程
            </Link>
            <Link href={demoShareHref(DEMO_SHOWCASE_SHARE_ID)} className="btn btn-ghost">
              查看示例行程
            </Link>
          </div>
        </div>
      </header>

      <div className="container about-sections">
        <section id="how" aria-labelledby="cap">
          <h2 id="cap">怎么用</h2>
          <div className="how-grid">
            <article className="how-item">
              <h3>出发前</h3>
              <p>
                按目的地和日期生成行程，或从<Link href="/cities">城市模板</Link>开始。
              </p>
            </article>
            <article className="how-item">
              <h3>在路上</h3>
              <p>打开行程的「今日」，按计划时间查看接下来的安排和导航入口。</p>
            </article>
            <article className="how-item">
              <h3>核对安排</h3>
              <p>
                用<Link href="/check">行程体检</Link>
                检查已有计划，程序会列出可检测的时间、路线和预算问题。
              </p>
            </article>
          </div>
        </section>

        <section id="trust" aria-labelledby="faq">
          <h2 id="faq">出发前还要确认什么</h2>
          <p>
            地点、营业时间和路线资料来自高德开放平台。体检标明已知信息和核验状态。临时闭馆、票价和预约请查场所公告。
          </p>
          <p>
            <Link href="/verify">开放验真台</Link>适合核验结构化文档。分享行程前，请先查看
            <Link href="/privacy#sharing">链接访问权限</Link>。
          </p>
        </section>
      </div>
    </main>
  );
}
