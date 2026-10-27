import type { Metadata } from "next";
import Link from "next/link";
import { IntentButton } from "@/components/IntentButton";

// 定价与付费意愿（S3 商业化试点）。
//
// 为什么现在做：先验证「愿意为什么付费」再谈支付——不接支付时页面必须把
// 「还没上线、不会收费」写在最显眼的位置，否则就是拿未兑现的东西钓鱼。
// 意愿通过 /api/events 的 upgrade_intent 上报（只有 tier 计数，没有身份信息）。

export const metadata: Metadata = {
  title: "定价与功能意愿 — 行程规划师",
  description:
    "现在全部功能免费、没有广告位。这里列出候选付费点并收集意愿：点击只是投票，不会收费、不承诺上线时间。",
  alternates: { canonical: "/pricing" },
};

const CANDIDATES = [
  {
    tier: "deep-check",
    name: "深度核验",
    priceHint: "候选：按次",
    desc: "更多候选 POI（每站给 3 个备选 + 通勤对比）、跨城交通与到达时间核验、行前 48 小时的营业时间复检。",
    why: "给「这趟不能出错」的场景（带父母、赶演出、异地婚礼）用。",
  },
  {
    tier: "trip-archive",
    name: "多行程与归档",
    priceHint: "候选：订阅",
    desc: "不限份数的行程归档、按年份/地区检索、把旧行程复制成新日期的一键重排。",
    why: "给一年出行 3 次以上、想留着历史行程的人用。",
  },
  {
    tier: "reminders",
    name: "行前 / 行中提醒",
    priceHint: "候选：订阅",
    desc: "出发前提醒做行前准备、当天早上推送今日安排、下一站出发提醒（微信/短信/推送）。",
    why: "给不想打开 App 也想被提醒的人用。",
  },
] as const;

export default function PricingPage() {
  return (
    <main className="pricing-page">
      <div className="container pricing-inner">
        <header className="pricing-hero">
          <p className="about-eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            定价 · 意愿收集
          </p>
          <h1 className="pricing-title">现在全部功能免费，未来怎么收费还没定</h1>
          <p className="pricing-lede">
            我们不卖排名、没有广告位、没有返佣（见
            <Link href="/about#neutrality">中立承诺</Link>）。付费点只可能来自「更强的核验」与
            「更省心的提醒」——但在做之前，我们想先知道你到底愿意为什么付钱。
          </p>
          <p className="pricing-honest">
            下面三个是<b>候选</b>功能，都还没做。点「我想要这个」只是投一票：
            <b>不会收费、不会承诺上线时间、不会记录你的身份信息</b>
            （看板只看到「某个候选被点了多少次」）。
          </p>
        </header>

        <div className="pricing-grid">
          <article className="pricing-card pricing-card-free">
            <div className="pricing-card-head">
              <h2>免费</h2>
              <span className="pricing-price">¥0</span>
            </div>
            <p className="pricing-card-desc">现在能用的全部功能，没有付费墙、没有广告：</p>
            <ul className="pricing-list">
              <li>事实先行生成（POI / 营业时间 / 闭馆日 / 真实通勤）</li>
              <li>可执行性体检（A–D 评分 + 证据链）</li>
              <li>换一个 / 一句话改 / 一键顺延 / 一键修复</li>
              <li>分享、克隆、行中模式（PWA 离线）、导出日历</li>
            </ul>
            <Link href="/new" className="btn btn-primary">
              先免费用起来 →
            </Link>
          </article>

          {CANDIDATES.map((c) => (
            <article key={c.tier} className="pricing-card" data-tier={c.tier}>
              <div className="pricing-card-head">
                <h2>{c.name}</h2>
                <span className="pricing-price">{c.priceHint}</span>
              </div>
              <p className="pricing-card-desc">{c.desc}</p>
              <p className="pricing-card-why">{c.why}</p>
              <IntentButton tier={c.tier} />
            </article>
          ))}
        </div>

        <section className="pricing-faq">
          <h2>关于收费，我们把话说清楚</h2>
          <dl>
            <dt>现在会收钱吗？</dt>
            <dd>不会。页面上没有任何支付入口；点意愿按钮也不扣费。</dd>
            <dt>点了之后会被推销吗？</dt>
            <dd>不会。我们只记「某个候选被点了多少次」，没有邮箱、手机号或账号可以联系你。</dd>
            <dt>会不会变成「基础免费、体检收费」？</dt>
            <dd>
              不会。体检（风险摊开）是产品的地基，不拿来当付费墙；付费点只可能是「更多候选」「跨城核验」「提醒」
              这类增量能力。
            </dd>
            <dt>数据拿去做什么？</dt>
            <dd>只用来决定先做哪个候选功能，聚合后出现在内部看板，不做用户画像、不对外出售。</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
