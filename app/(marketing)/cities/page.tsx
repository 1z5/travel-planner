import type { Metadata } from "next";
import Link from "next/link";
import { CITY_TEMPLATES } from "@/lib/plan/city-templates";

export const metadata: Metadata = {
  title: "城市模板 — AI Travel Companion",
  description: "按城市和天数选择示例条件，再在新建行程里调整。",
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
            模板提供城市、天数、偏好和预算参考，<b>不是已经核验过的行程</b>。选定模板后可修改表单。
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
          </div>
          <Link href="/new" className="btn btn-primary">
            新建行程
          </Link>
        </section>
      </div>
    </main>
  );
}
