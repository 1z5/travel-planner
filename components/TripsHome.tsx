"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  ChevronRight,
  Heart,
  Plus,
  Trash2,
} from "lucide-react";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { FEATURED_DESTINATIONS, featuredHref } from "@/lib/featured-destinations";
import {
  loadRecentTrips,
  recentTripLabel,
  removeRecentTrip,
  type RecentTrip,
} from "@/lib/recent-trips";
import { loadWishlist, removeWish, type WishlistTrip } from "@/lib/wishlist";
import { countdownFor } from "@/lib/countdown";
import { localTodayIso } from "@/lib/trip-day";

// ============================================================
// 产品首页：我的行程（ATLAS v6 改版）
//
// v6 的变化不是「换皮」，是换结构：
// 1. 首屏从「一张大纸卡 + 三段文案」变成「左侧主张 + 右侧仪器面板」——
//    右侧用真实示例数据（SAMPLE_PLAN，MOCK）展示产品长什么样，并如实标注
//    未验真；新用户第一屏就同时看到「主张」与「证据样本」。
// 2. 主张下面是一条**真的能用的快速开始**（城市 + 天数 → /new 深链预填），
//    不是装饰性输入框；主 CTA 仍是「开始规划」（唯一的新建入口契约）。
// 3. 我的行程 / 精选示例 / 想去清单全部改成仪器语言：等宽编号、状态胶囊、
//    倒计时读数、bento 网格。
//
// 测试契约（tests/components/TripsHome.test.tsx）必须继续满足：
// - 新用户首屏有「先核验真实世界，再排行程」这段**完整文本**（一个文本节点）；
// - 只有一个 role=link 且名为「开始规划」（href=/new）、一个「看一份真实示例」；
// - 「MOCK 高德 · POI 未验真」「真实生成的示例」「示例条件」各只出现一次（getByText）；
// - 回归用户的 hero 不再出现示例面板（否则「苏州」会与最近行程列表同名）。
// ============================================================

const QUICK_DAYS = [2, 3, 4, 5] as const;

export function TripsHome() {
  const [trips, setTrips] = useState<RecentTrip[]>([]);
  const [wishlist, setWishlist] = useState<WishlistTrip[]>([]);
  // 今天的日期只在客户端算（SSR 时区不一定等于用户手机时区），用于倒计时。
  const [todayIso, setTodayIso] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 快速开始（真功能：跳到新建页并用深链预填；不在这里发请求）
  const [quickCity, setQuickCity] = useState("");
  const [quickDays, setQuickDays] = useState<(typeof QUICK_DAYS)[number]>(3);

  useEffect(() => {
    setTrips(loadRecentTrips());
    setWishlist(loadWishlist());
    setTodayIso(localTodayIso());
    setLoaded(true);
  }, []);

  const isNewUser = loaded && trips.length === 0 && wishlist.length === 0;

  const specimen = SAMPLE_PLAN;

  return (
    <main className="trips-home">
      <div className="container trips-home-inner">
        {/* ===== 首屏：主张 + 仪器面板 ===== */}
        <section
          className={`home-action${isNewUser ? " home-action-new" : ""}`}
          aria-label="新建行程"
        >
          <div className="home-action-copy">
            {isNewUser ? (
              <>
                <p className="firstscreen-eyebrow">
                  <span className="eyebrow-dot" aria-hidden="true" />
                  事实先行 · 生成前先核验真实世界
                </p>
                <h1 className="firstscreen-title">先核验真实世界，再排行程</h1>
                <p className="firstscreen-lede">
                  先说去哪、几天、大概预算。我们先用高德核验真实 POI、营业时间与通勤，再排成
                  <strong>走得通的行程</strong>
                  ——闭馆、绕路、时间接不上，出发前就标出来。
                </p>
              </>
            ) : (
              <>
                <p className="firstscreen-eyebrow">
                  <span className="eyebrow-dot" aria-hidden="true" />
                  新建行程
                </p>
                <h1 className="firstscreen-title home-action-title">再规划一趟</h1>
                <p className="firstscreen-lede">
                  输入目的地、日期和预算，2–4 分钟生成；期间可离开页面，回来接着看。
                </p>
              </>
            )}

            {/* 快速开始：城市 + 天数 → 新建页深链预填（真导航，不是占位） */}
            {/* 原生 GET 表单：不依赖 useRouter（组件测试在 jsdom 里没有 App Router
                上下文，用 router 会直接抛错），并且没有 JS 时也能跳转。
                提交到 /new 后由该页读取 search 参数预填，口径与深链一致。 */}
            <form className="quickstart" action="/new" method="get" aria-label="快速开始">
              <span className="quickstart-label" aria-hidden="true">
                快速开始
              </span>
              <label className="sr-only" htmlFor="qs-city">
                目的地城市
              </label>
              <input type="hidden" name="days" value={quickDays} />
              <input
                id="qs-city"
                name="city"
                className="quickstart-city"
                value={quickCity}
                onChange={(e) => setQuickCity(e.target.value)}
                placeholder="输入城市，如：成都"
                maxLength={20}
                autoComplete="off"
              />
              <div className="quickstart-days" role="group" aria-label="出行天数">
                {QUICK_DAYS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`quickstart-day${quickDays === n ? " is-on" : ""}`}
                    aria-pressed={quickDays === n}
                    onClick={() => setQuickDays(n)}
                  >
                    {n} 天
                  </button>
                ))}
              </div>
              <button
                type="submit"
                className="quickstart-go"
                aria-label="用这些条件开始规划"
                title="用这些条件开始规划"
              >
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </form>

            <div className="firstscreen-cta">
              <Link href="/new" className="btn-primary firstscreen-btn">
                <Plus size={16} aria-hidden="true" />
                开始规划
              </Link>
              <Link href="/new?sample=1" className="btn btn-ghost">
                看一份真实示例
              </Link>
            </div>

            <p className="home-action-hint">
              <span>
                还没想好去哪？
                <Link href="/cities">按城市看模板（12 城 · 3/4/5 天）</Link>
              </span>
              <span>
                手上已有一份 AI 行程？
                <Link href="/verify">先给它做体检</Link>
              </span>
            </p>

            {/* 一行能力点：把营销从「三张长卡」压缩成一行，不占首屏高度 */}
            <ul className="home-chips firstscreen-points" aria-label="产品能力">
              <li>高德验真 POI / 营业时间 / 通勤</li>
              <li>可执行性体检 A–D</li>
              <li>改坏了能撤销</li>
            </ul>
          </div>

          {/* 右侧仪器面板：只在「空房间」出现——用真实示例数据说明输出长什么样。
              它是证据样本，不是营销插画：明确标注 MOCK 未验真。 */}
          {isNewUser && (
            <aside className="home-specimen" aria-label="真实生成的示例行程">
              <div className="specimen-head">
                <span className="specimen-tag">SPECIMEN · 示例样本</span>
                <span className="specimen-status">示例数据 · 未验真</span>
              </div>

              <div className="specimen-map" aria-hidden="true">
                <svg viewBox="0 0 320 132" role="presentation" focusable="false">
                  <path className="specimen-route" d="M22 96 L88 62 L152 80 L214 40 L296 54" />
                  <circle className="specimen-node" cx="22" cy="96" r="4" />
                  <circle className="specimen-node" cx="88" cy="62" r="4" />
                  <circle className="specimen-node" cx="152" cy="80" r="4" />
                  <circle className="specimen-node" cx="214" cy="40" r="4" />
                  <circle className="specimen-node specimen-node-end" cx="296" cy="54" r="5" />
                </svg>
                <span className="specimen-coord">31.29°N · 120.58°E</span>
              </div>

              <p className="specimen-city">
                {specimen.city}
                <span className="specimen-daycount">{specimen.days.length} 天</span>
              </p>
              <ol className="specimen-days">
                {specimen.days.slice(0, 3).map((d) => (
                  <li key={d.day}>
                    <span className="specimen-dayno">D{String(d.day).padStart(2, "0")}</span>
                    <span className="specimen-theme">{d.theme}</span>
                    <span className="specimen-count">{d.spots.length} 站</span>
                  </li>
                ))}
              </ol>
              <div className="specimen-foot">
                <span className="specimen-chip">POI 未验真 · MOCK</span>
                <span className="specimen-chip specimen-chip-warn">
                  体检 {specimen.warnings.length} 项提醒
                </span>
              </div>
            </aside>
          )}
        </section>

        {/* ===== 回访：我的行程 ===== */}
        {loaded && trips.length > 0 && (
          <section className="trips-list" aria-label="行程列表">
            <header className="home-section-head">
              <h2 className="home-section-title">
                <CalendarDays size={15} aria-hidden="true" /> 我的行程
              </h2>
              <p className="home-section-sub">存在这台设备上；链接不会过期。</p>
            </header>
            {trips.map((trip, i) => (
              <article className="trip-card" key={trip.shareId}>
                <Link className="trip-card-main" href={`/w/${trip.shareId}`}>
                  {/* 序号是「列表位置」不是天数：天数在 meta 里，别让两个数字打架 */}
                  <span className="trip-card-index" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="trip-card-city">{trip.city}</span>
                  <span className="trip-card-meta">
                    <CalendarDays size={14} />
                    {recentTripLabel(trip)}
                  </span>
                  {trip.summary && <span className="trip-card-summary">{trip.summary}</span>}
                  {(() => {
                    // 行前倒计时（D2）：只对「有合法日期」的行程显示，拿不到就不显示
                    const cd = todayIso ? countdownFor(trip.startDate, trip.days, todayIso) : null;
                    return cd ? (
                      <span className={`trip-card-countdown trip-card-countdown-${cd.tone}`}>
                        {cd.text}
                      </span>
                    ) : null;
                  })()}
                  <span className="trip-card-open">
                    继续规划 <ArrowUpRight size={14} />
                  </span>
                </Link>
                <button
                  type="button"
                  className="trip-card-remove"
                  aria-label={`从我的行程中移除 ${trip.city}`}
                  title="从这台设备移除（不影响已分享的链接）"
                  onClick={() => setTrips(removeRecentTrip(trip.shareId))}
                >
                  <Trash2 size={15} />
                </button>
              </article>
            ))}
          </section>
        )}

        {/* ===== 精选示例（真实生成样本 + 示例条件） ===== */}
        <section className="home-examples" aria-labelledby="home-examples-title">
          <header className="home-section-head">
            <h2 className="home-section-title" id="home-examples-title">
              精选示例
            </h2>
            <p className="home-section-sub">
              示例条件不是已核验行程：点开只把城市、天数、偏好带进表单，生成时逐条核验。
            </p>
          </header>

          <div className="firstscreen-evidence">
            {FEATURED_DESTINATIONS.map((d, i) => (
              <article className="fs-card" key={d.city}>
                <div className="fs-card-head">
                  <span className="fs-card-tag">示例条件</span>
                  <span className="fs-card-note">{d.prefs.join(" · ")}</span>
                </div>
                <span className="fs-card-index" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="fs-card-title">
                  {d.city} · {d.days} 天
                </h3>
                <p className="fs-card-body">{d.blurb}</p>
                <Link href={featuredHref(d)} className="fs-card-link">
                  用这个条件开始 <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </article>
            ))}

            {/* 真实生成的示例：同一份数据里既有完整行程、也有被体检拦下的问题。
                SAMPLE_PLAN 是 MOCK 数据（verified:false），必须如实标注「未验真」。 */}
            <article className="fs-card fs-card-warn">
              <div className="fs-card-head">
                <span className="fs-card-tag">真实生成的示例</span>
                <span className="fs-card-note">MOCK 高德 · POI 未验真</span>
              </div>
              <span className="fs-card-index" aria-hidden="true">
                04
              </span>
              <h3 className="fs-card-title">
                {SAMPLE_PLAN.city} · {SAMPLE_PLAN.days.length} 天
              </h3>
              <ul className="fs-warn-list">
                {SAMPLE_PLAN.warnings.slice(0, 2).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              <p className="fs-card-body">体检把问题标出来：能修的一键修，修不了的明说修不了。</p>
              <Link href="/new?sample=1" className="fs-card-link">
                打开完整示例 <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </article>
          </div>

          {/* 三步管线：把「怎么做到的」压成一行读数，而不是三段长文案 */}
          <ol className="home-steps" aria-label="产品管线">
            <li>
              <span className="home-step-no">01</span>
              <span className="home-step-title">约束输入</span>
              <span className="home-step-desc">
                预算 / 时间 / 偏好是硬约束，模型只输出结构化行程
              </span>
            </li>
            <li>
              <span className="home-step-no">02</span>
              <span className="home-step-title">事实核验</span>
              <span className="home-step-desc">POI / 营业时间 / 闭馆日 / 通勤逐点过高德</span>
            </li>
            <li>
              <span className="home-step-no">03</span>
              <span className="home-step-title">体检修复</span>
              <span className="home-step-desc">
                绕路 / 节奏 / 预算 / 时间轴问题摊开，能修的确定性修
              </span>
            </li>
          </ol>
        </section>

        {/* ===== 想去清单 ===== */}
        {loaded && wishlist.length > 0 && (
          <section className="wishlist" aria-label="想去清单">
            <header className="wishlist-head">
              <h2 className="wishlist-title">
                <Heart size={15} aria-hidden="true" />
                想去
              </h2>
              <p className="wishlist-sub">收藏的行程存在这台设备上，点开就能接着看。</p>
            </header>
            <div className="wishlist-list">
              {wishlist.map((w) => (
                <article className="wishlist-card" key={w.shareId}>
                  <Link className="wishlist-main" href={`/p/${w.shareId}`}>
                    <span className="wishlist-city">{w.city}</span>
                    <span className="wishlist-meta">
                      {w.days} 天{w.startDate ? ` · ${w.startDate}` : ""}
                    </span>
                    {w.summary && <span className="wishlist-summary">{w.summary}</span>}
                    <ChevronRight size={14} className="wishlist-chev" aria-hidden="true" />
                  </Link>
                  <button
                    type="button"
                    className="wishlist-remove"
                    aria-label={`从想去清单移除 ${w.city}`}
                    title="从想去清单移除"
                    onClick={() => setWishlist(removeWish(w.shareId))}
                  >
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
