import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  CITY_TEMPLATES,
  cityTemplateBySlug,
  templateHref,
  type CityTemplate,
} from "@/lib/city-templates";

// 城市模板详情页（产品线 B2）：某城市的 3/4/5 天条件模板。
//
// 页面只是「起手条件」，不包含任何 POI 事实（营业时间/评分/票价一律不写）——
// 写了就等于暗示已核验过，而模板页根本没有跑过高德。真实信息在生成后的行程里，
// 逐条带核验状态。

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
  if (!t) return { title: "城市模板 — 行程规划师" };
  return {
    title: `${t.city} 3/4/5 天行程模板（示例条件）— 行程规划师`,
    description: `${t.city}玩几天合适？${t.variants.map((v) => v.days).join("/")} 天条件模板：${t.tagline} 生成时逐条核验真实 POI、营业时间与通勤。`,
    alternates: { canonical: `/cities/${t.slug}` },
    openGraph: {
      title: `${t.city} 3/4/5 天行程模板`,
      description: t.tagline,
      type: "article",
      siteName: "行程规划师",
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
          {t.variants.map((v) => (
            <article key={v.days} className="cities-variant" data-days={v.days}>
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

        <section className="cities-honest">
          <h2>这里是条件模板，不是行程</h2>
          <ul>
            <li>
              页面上的天数、偏好、预算是<b>示例条件</b>，你可以在表单里改成自己的。
            </li>
            <li>没有写任何 POI 的营业时间、评分或票价——模板页没有跑过真实核验，写了就是编。</li>
            <li>
              生成后才会逐条核验：POI 是否存在、几点开门、哪天闭馆、两站之间要走多久，
              并把风险摊开（可执行性评分 + 证据链）。
            </li>
          </ul>
        </section>

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
