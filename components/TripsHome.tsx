"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, CalendarDays, Heart, Plus, Trash2 } from "lucide-react";
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
// 产品首页：我的行程（2026-10 改版）
//
// 改版动机（用户反馈 + 自评）：
// 1. **重复**：顶栏「新建行程」+ 页头「新建行程」+ 空态 CTA 三处重复 → 收敛成
//    一张「主行动卡」，卡片本身就是主要入口（有特色、显眼）。
// 2. **文字太多**：首屏从「标题 + 长说明 + 三张长卡」压成「一句主张 + 一句说明 +
//    行动卡」；说明只保留「体检」这句差异化，不写功能清单。
// 3. **「不知道去哪」不适配定位**：我们用「精选示例」承接——重点是让人**看到
//    一份真实生成长什么样**，而不是把产品做成灵感社区。
// 4. **网格**：行动卡 → 我的行程 → 精选示例 → 能力点，一条纵向主线；不再让
//    营销区块和行程列表混在一起。
//
// 刻意不做的：不做「分步向导」。规划是一次性主任务 + 回访列表，向导会让回访
// 用户多点两次；卡片化单页已经达到「一屏看到下一步」的目的。
// ============================================================

export function TripsHome() {
  const [trips, setTrips] = useState<RecentTrip[]>([]);
  const [wishlist, setWishlist] = useState<WishlistTrip[]>([]);
  // 今天的日期只在客户端算（SSR 时区不一定等于用户手机时区），用于倒计时。
  const [todayIso, setTodayIso] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTrips(loadRecentTrips());
    setWishlist(loadWishlist());
    setTodayIso(localTodayIso());
    setLoaded(true);
  }, []);

  const isNewUser = loaded && trips.length === 0 && wishlist.length === 0;

  return (
    <main className="trips-home">
      <div className="container trips-home-inner">
        {/* ===== 主行动卡（唯一的新建入口，空态时承载产品主张） ===== */}
        <section
          className={`home-action${isNewUser ? " home-action-new" : ""}`}
          aria-label="新建行程"
        >
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
          <div className="firstscreen-cta">
            <Link href="/new" className="btn btn-primary firstscreen-btn">
              <Plus size={16} aria-hidden="true" />
              开始规划
            </Link>
            <Link href="/new?sample=1" className="btn btn-ghost">
              看一份真实示例
            </Link>
          </div>
          <p className="home-action-hint">
            还没想好去哪？
            <Link href="/cities">按城市看模板（12 城 · 3/4/5 天）</Link>
          </p>
          {/* 一行能力点：把营销从「三张长卡」压缩成一行，不占首屏高度 */}
          <ul className="home-chips" aria-label="产品能力">
            <li>高德验真 POI / 营业时间 / 通勤</li>
            <li>可执行性体检 A–D</li>
            <li>改坏了能撤销</li>
          </ul>
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
            {trips.map((trip) => (
              <article className="trip-card" key={trip.shareId}>
                <Link className="trip-card-main" href={`/w/${trip.shareId}`}>
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
            {FEATURED_DESTINATIONS.map((d) => (
              <article className="fs-card" key={d.city}>
                <div className="fs-card-head">
                  <span className="fs-card-tag">示例条件</span>
                  <span className="fs-card-note">{d.prefs.join(" · ")}</span>
                </div>
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
