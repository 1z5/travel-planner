"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Footprints,
  BookOpen,
  Heart,
  MapPin,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import { DEMO_SHOWCASE_SHARE_ID, demoShareHref } from "@/lib/demo/demo-links";
import { FEATURED_DESTINATIONS, featuredHref } from "@/lib/plan/featured-destinations";
import {
  loadRecentTrips,
  recentTripLabel,
  removeRecentTrip,
  saveRecentTrip,
  type RecentTrip,
} from "@/lib/plan/recent-trips";
import { loadWishlist, removeWish, type WishlistTrip } from "@/lib/plan/wishlist";
import { countdownFor } from "@/lib/trip/countdown";
import { localTodayIso } from "@/lib/trip/trip-day";

import { localTripHref } from "@/lib/trip/local-library";
import type { LocalTripSummary } from "@/lib/trip/local-trips";

function WalkCover() {
  return (
    <section className="walk-cover" aria-labelledby="walk-cover-title">
      <div className="walk-cover-copy">
        <p className="walk-byline">
          <Footprints size={16} aria-hidden="true" /> 东京 · 步行示例
        </p>
        <h2 id="walk-cover-title">
          从浅草寺
          <br />
          走到隅田川
        </h2>
        <p className="walk-deck">沿着两站散步路线，试试导航、到达打卡，记下路上看到的风景。</p>
        <a href="/local?open=tokyo" className="walk-cta">
          体验这段散步 <ArrowRight size={16} aria-hidden="true" />
        </a>
      </div>
      <figure>
        <Image
          src="/images/asakusa-walk.webp"
          width={1050}
          height={700}
          alt=""
          preload
          sizes="(max-width: 700px) 96vw, 620px"
        />
        <figcaption>东京 · 浅草街区插画</figcaption>
      </figure>
    </section>
  );
}

export function TripsHome() {
  const [trips, setTrips] = useState<RecentTrip[]>([]);
  const [localTrip, setLocalTrip] = useState<LocalTripSummary>();
  const [wishlist, setWishlist] = useState<WishlistTrip[]>([]);
  const [today, setToday] = useState<string>();
  const [removed, setRemoved] = useState<RecentTrip>();

  useEffect(() => {
    let request = 0;
    function refresh() {
      const current = ++request;
      setTrips(loadRecentTrips());
      void import("@/lib/trip/local-trips")
        .then(({ readSavedTrips }) => readSavedTrips())
        .then(
          ({ trips }) => {
            if (current === request) setLocalTrip(trips[0]);
          },
          () => {
            if (current === request) setLocalTrip(undefined);
          },
        );
      setWishlist(loadWishlist());
      setToday(localTodayIso());
    }
    // 旅行中从地图切回窗口时，名单和日期可能已经变化。
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      request++;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  const datedTrips = trips.map((trip) => ({
    trip,
    countdown: today ? countdownFor(trip.startDate, trip.days, today) : null,
  }));
  const orderedTrips = [
    ...datedTrips.filter(({ countdown }) => countdown?.tone === "active"),
    ...datedTrips.filter(({ countdown }) => countdown?.tone !== "active"),
  ];

  return (
    <main className="trips-home companion-home">
      <div className="container trips-home-inner">
        <header className="companion-page-heading">
          <div>
            <h1>我的行程</h1>
          </div>
          <div className="field-heading-actions">
            <a className="btn" href="/local">
              <BookOpen size={16} aria-hidden="true" /> 本机行程
            </a>
            {localTrip || trips.length > 0 ? (
              <Link prefetch={false} href="/new" className="btn">
                <Plus size={17} aria-hidden="true" /> 新建行程
              </Link>
            ) : null}
          </div>
        </header>

        {removed && (
          <div className="companion-notice">
            <span role="status">已从这台设备移除 {removed.city}</span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTrips(saveRecentTrip(removed));
                setRemoved(undefined);
              }}
            >
              撤销
            </button>
          </div>
        )}

        {localTrip && (
          <section className="field-resume">
            <div>
              <p>最近更新的本机行程</p>
              <h2>{localTrip.name}</h2>
            </div>
            <a href={localTripHref(localTrip.id)} className="btn btn-primary">
              {localTrip.walk ? "继续手记" : "继续旅程"} <ArrowRight size={16} aria-hidden="true" />
            </a>
          </section>
        )}
        <section className="field-departure" aria-labelledby="field-departure-title">
          <div>
            <h2 id="field-departure-title">从眼前这一站开始</h2>
            <p>随手记下停留、照片和路上的见闻。</p>
          </div>
          <a
            className={`btn field-start-walk${localTrip ? "" : " btn-primary"}`}
            href="/local?open=walk"
          >
            <Footprints size={19} aria-hidden="true" /> 开始随走
            <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
        {!localTrip && orderedTrips.length === 0 && <WalkCover />}
        {orderedTrips.length > 0 ? (
          <section className="companion-trip-list" aria-label="行程列表">
            {orderedTrips.map(({ trip, countdown }) => {
              const active = countdown?.tone === "active";
              return (
                <article
                  className="companion-trip"
                  key={trip.shareId}
                  data-active={active || undefined}
                >
                  <div className="companion-trip-icon">
                    <MapPin size={22} aria-hidden="true" />
                  </div>
                  <div className="companion-trip-info">
                    <h2>
                      <Link href={active ? `/t/${trip.shareId}` : `/w/${trip.shareId}`}>
                        {trip.city}
                      </Link>
                    </h2>
                    <div className="companion-trip-meta">
                      <span>
                        <CalendarDays size={14} aria-hidden="true" />
                        {recentTripLabel(trip)}
                      </span>
                      {countdown && <span className="companion-trip-status">{countdown.text}</span>}
                    </div>
                    {trip.summary && <p>{trip.summary}</p>}
                  </div>
                  <div className="companion-trip-actions">
                    {active ? (
                      <Link href={`/t/${trip.shareId}`} className="btn btn-primary">
                        查看今日 <ArrowRight size={15} aria-hidden="true" />
                      </Link>
                    ) : (
                      <Link href={`/w/${trip.shareId}`} className="btn">
                        打开行程 <ArrowRight size={15} aria-hidden="true" />
                      </Link>
                    )}
                    {active && (
                      <Link href={`/w/${trip.shareId}?view=plan`} className="btn">
                        查看计划
                      </Link>
                    )}
                    <button
                      type="button"
                      className="btn companion-icon-button"
                      aria-label={`从我的行程中移除 ${trip.city}`}
                      title="从这台设备移除"
                      onClick={() => {
                        setTrips(removeRecentTrip(trip.shareId));
                        setRemoved(trip);
                      }}
                    >
                      <X size={17} aria-hidden="true" />
                    </button>
                  </div>
                </article>
              );
            })}
          </section>
        ) : (
          <section className="companion-start" aria-label="开始旅行">
            <div className="companion-start-content">
              <h2>准备下一趟旅行</h2>

              <form
                action="/new"
                method="get"
                aria-label="快速开始"
                className="companion-start-form"
              >
                <label>
                  <span>目的地</span>
                  <input name="city" placeholder="例如，成都" maxLength={20} />
                </label>
                <label>
                  <span>天数</span>
                  <select name="days" defaultValue="3">
                    {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                      <option value={day} key={day}>
                        {day} 天
                      </option>
                    ))}
                  </select>
                </label>
                <button type="submit" className="btn btn-primary">
                  开始规划 <ArrowRight size={17} aria-hidden="true" />
                </button>
              </form>
              <Link prefetch={false} href="/check" className="companion-inline-link">
                <ShieldCheck size={16} aria-hidden="true" /> 已有行程？先做体检{" "}
                <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </div>

            <Link href={demoShareHref(DEMO_SHOWCASE_SHARE_ID)} className="companion-example">
              <Image
                src="/images/companion-canal.webp"
                width={1280}
                height={720}
                alt=""
                sizes="(max-width: 760px) 92vw, 420px"
              />
              <div className="companion-example-caption">
                <div>
                  <span>已核验的示例行程</span>
                  <strong>苏州 · 3 天</strong>
                </div>
                <ArrowUpRight size={20} aria-hidden="true" />
              </div>
            </Link>
          </section>
        )}

        {wishlist.length > 0 && (
          <section className="companion-home-section" aria-label="想去">
            <h2>
              <Heart size={19} aria-hidden="true" /> 想去
            </h2>
            <div className="companion-trip-list">
              {wishlist.map((wish) => (
                <article className="companion-trip" key={wish.shareId}>
                  <div className="companion-trip-info">
                    <h3>
                      <Link href={`/p/${wish.shareId}`}>{wish.city}</Link>
                    </h3>
                    <p>
                      {wish.days} 天{wish.startDate ? ` · ${wish.startDate}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="btn companion-icon-button"
                    aria-label={`从想去清单移除 ${wish.city}`}
                    onClick={() => setWishlist(removeWish(wish.shareId))}
                  >
                    <X size={17} aria-hidden="true" />
                  </button>
                </article>
              ))}
            </div>
          </section>
        )}

        <section className="companion-home-section" aria-labelledby="companion-templates">
          <div className="companion-section-heading">
            <h2 id="companion-templates">从城市模板开始</h2>
            <Link href="/cities" className="companion-inline-link">
              全部城市 <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
          <div className="companion-template-list">
            {FEATURED_DESTINATIONS.map((destination) => (
              <Link
                prefetch={false}
                href={featuredHref(destination)}
                className="companion-template"
                key={destination.city}
              >
                <strong>
                  {destination.city} <span>· {destination.days} 天</span>
                </strong>
                <p>{destination.prefs.join(" · ")}</p>
                <ArrowUpRight size={16} aria-hidden="true" />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
