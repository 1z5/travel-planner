import type { Metadata } from "next";
import Link from "next/link";

// ============================================================
// 定价页（2026-11-10 起：纯历史留档）
//
// 本项目已放弃商业化，转为个人开源技术展示项目。这一页不再收集任何意愿
// （IntentButton 已随投票机制一并移除），只回答一个问题：「这个项目收费吗？」
// —— 不收，也不会收。下面保留当时的候选设想，仅作决策记录。
//
// 为什么页面还留着而不是删掉：搜索引擎与旧分享链接里已有这个 URL，
// 让 URL 变成 404 不如让它变成一句诚实的回答。（e2e 仍断言本页 200。）
// ============================================================

export const metadata: Metadata = {
  title: "定价 — 行程规划师",
  description: "本项目全部功能免费、不计划商业化。此页为历史决策留档。",
  alternates: { canonical: "/pricing" },
};

const ARCHIVED_IDEAS = [
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
            定价 · 历史留档
          </p>
          <h1 className="pricing-title">本项目全部功能免费，不计划商业化</h1>
          <p className="pricing-lede">
            这是一个个人开源技术展示项目（Apache-2.0）。不会收费、没有广告位、没有返佣，
            也不收集付费意愿——意愿投票机制已于 2026-11-10 移除。
          </p>
          <p className="pricing-honest">
            <b>为什么留着这个页面：</b>旧链接不该变成 404。下面三个是 2026-10 商业化探索期 的
            <b>候选</b>设想，从未实现、已作废，仅作决策记录。
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
              免费新建行程 →
            </Link>
          </article>

          {ARCHIVED_IDEAS.map((c) => (
            <article key={c.tier} className="pricing-card" data-tier={c.tier}>
              <div className="pricing-card-head">
                <h2>{c.name}</h2>
                <span className="pricing-price">{c.priceHint}</span>
              </div>
              <p className="pricing-card-desc">{c.desc}</p>
              <p className="pricing-card-why">{c.why}</p>
              <p className="pricing-card-why">
                <b>状态：已作废（2026-11-08 放弃商业化）</b>
              </p>
            </article>
          ))}
        </div>

        <section className="pricing-faq">
          <h2>关于收费，我们把话说清楚</h2>
          <dl>
            <dt>现在会收钱吗？</dt>
            <dd>不会。页面上没有任何支付入口，也没有任何投票/意愿收集入口。</dd>
            <dt>以后会变成「基础免费、体检收费」吗？</dt>
            <dd>
              不会。本项目已定位为开源技术展示，体检（风险摊开）是整个设计的地基，源码以 Apache-2.0
              开放，任何人都可以自己部署完整功能。
            </dd>
            <dt>那这个项目靠什么维持？</dt>
            <dd>不维持营收。它是作者的技术作品，演示站跑在免费实例上，重启会丢数据。</dd>
          </dl>
        </section>
      </div>
    </main>
  );
}
