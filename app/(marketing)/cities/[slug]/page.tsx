import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CITY_TEMPLATES,
  cityTemplateBySlug,
  templateHref,
  type CityTemplate,
} from "@/lib/plan/city-templates";

// 只允许 generateStaticParams 列出的 slug：未知城市在路由层直接 404，
// 而不是「先渲染再 notFound()」（dev 下后者会 200 + 客户端切 404，SEO 与测试都糟）。
export const dynamicParams = false;

function findTemplate(slug: string): CityTemplate {
  const t = cityTemplateBySlug(slug);
  if (!t) notFound();
  return t;
}

export function generateStaticParams() {
  return CITY_TEMPLATES.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const t = cityTemplateBySlug(slug);
  if (!t) return { title: "城市模板 — AI Travel Companion" };
  const durations = t.variants.map((v) => v.days).join("/");
  return {
    title: `${t.city} ${durations} 天行程模板 — AI Travel Companion`,
    description: `${t.city} ${durations} 天的示例条件，可在新建行程中调整。`,
    alternates: { canonical: `/cities/${t.slug}` },
    openGraph: {
      title: `${t.city} ${durations} 天行程模板`,
      description: t.tagline,
      type: "article",
      siteName: "AI Travel Companion",
    },
  };
}

export default async function CityTemplatePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = findTemplate(slug);

  return (
    <main className="cities-page">
      <div className="container">
        <nav className="cities-crumb" aria-label="面包屑">
          <Link href="/cities">城市模板</Link>
          <span aria-hidden="true">/</span>
          <span>{t.city}</span>
        </nav>

        <header className="cities-hero">
          <p className="about-eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            {t.region} · 示例条件
          </p>
          <h1 className="cities-title">{t.city}</h1>
          <p className="cities-lede">{t.tagline}</p>
          <p className="cities-season">什么时候去：{t.season}</p>
        </header>

        <div className="cities-variants">
          {t.variants.map((v, i) => (
            <article
              key={v.days}
              className="cities-variant"
              data-days={v.days}
              data-plate={String(i + 1).padStart(2, "0")}
            >
              <div className="cities-variant-head">
                <h2 className="cities-variant-title">{v.days} 天</h2>
                <span className="cities-variant-budget">
                  示例预算 人均 ¥{v.budget.toLocaleString("zh-CN")}
                </span>
              </div>
              <p className="cities-variant-prefs">
                {v.prefs.map((p) => (
                  <span key={p} className="cities-pref-chip">
                    {p}
                  </span>
                ))}
              </p>
              <p className="cities-variant-blurb">{v.blurb}</p>
              <Link href={templateHref(t.city, v.days, v.prefs)} className="btn btn-primary">
                用这个条件生成 →
              </Link>
            </article>
          ))}
        </div>

        <nav className="cities-others" aria-label="其它城市">
          <h2>再看看其它城市</h2>
          <ul>
            {CITY_TEMPLATES.filter((c) => c.slug !== t.slug).map((c) => (
              <li key={c.slug}>
                <Link href={`/cities/${c.slug}`}>
                  {c.city} · {c.region}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </main>
  );
}
