import type { Metadata } from "next";
import Link from "next/link";
import { CITY_TEMPLATES, templateHref } from "@/lib/city-templates";

// 城市模板索引页（产品线 B2，SEO 获取层）。
//
// 定位：给「只知道想去哪、还没想清楚几天」的人一个起点。**这里没有行程**，
// 只有「城市 + 天数 + 偏好 + 预算量级」的条件模板；点进去只是把条件带进表单，
// 生成时仍然逐条核验真实 POI、营业时间与通勤。页面必须写明这一点。

export const metadata: Metadata = {
  title: "城市行程模板：选城市和天数，直接开始 — 行程规划师",
  description:
    "12 个城市的 3/4/5 天行程模板（示例条件）：点一下把城市、天数和偏好带进表单，生成时逐条核验真实 POI、营业时间与通勤。",
  alternates: { canonical: "/cities" },
};

export default function CitiesPage() {
  return (
    <main className="cities-page">
      <div className="container">
        <header className="cities-hero">
          <p className="about-eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            城市模板 · 示例条件
          </p>
          <h1 className="cities-title">先去哪儿，住几天？</h1>
          <p className="cities-lede">
            下面是 12 个城市的 3/4/5 天<b>条件模板</b>——只有城市、天数、偏好和预算量级，
            <b>不是已经核验过的行程</b>。点「用这个条件生成」会把条件带进表单，生成时会逐条 核验真实
            POI、营业时间与通勤，并把风险摊开给你看。
          </p>
        </header>

        <ul className="cities-grid">
          {CITY_TEMPLATES.map((c, i) => (
            <li key={c.slug} className="cities-card" data-plate={String(i + 1).padStart(2, "0")}>
              <Link href={`/cities/${c.slug}`} className="cities-card-main">
                <span className="cities-card-region">{c.region}</span>
                <span className="cities-card-city">{c.city}</span>
                <span className="cities-card-tagline">{c.tagline}</span>
                <span className="cities-card-days">
                  {c.variants.map((v) => (
                    <span key={v.days} className="cities-days-chip">
                      {v.days} 天
                    </span>
                  ))}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <section className="cities-cta">
          <div>
            <h2>想去的城市不在上面？</h2>
            <p>直接填城市、日期和偏好也能开始——模板只是省一步，不是唯一入口。</p>
          </div>
          <Link href={templateHref("成都", 3, ["美食", "历史文化"])} className="btn btn-primary">
            直接开始规划 →
          </Link>
        </section>
      </div>
    </main>
  );
}
