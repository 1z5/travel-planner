"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, Plus, Trash2 } from "lucide-react";
import {
  loadRecentTrips,
  recentTripLabel,
  removeRecentTrip,
  type RecentTrip,
} from "@/lib/recent-trips";

// ============================================================
// 产品首页：我的行程。
//
// 之前这里是营销首页 + 长表单，回访用户要滚过 hero/信任条/营销区块才能
// 接着用。现在产品入口就是「这台设备上的行程」——回访用户一秒续上，
// 新用户看到空态 + 一个明确的开始动作；营销故事搬到 /about。
// ============================================================

export function TripsHome() {
  const [trips, setTrips] = useState<RecentTrip[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTrips(loadRecentTrips());
    setLoaded(true);
  }, []);

  return (
    <main className="trips-home">
      <div className="container trips-home-inner">
        <header className="trips-head">
          <div>
            <p className="trips-eyebrow">TRIPS · 我的行程</p>
            <h1 className="trips-title">我的行程</h1>
            <p className="trips-sub">存在这台设备上的行程，链接不会过期。</p>
          </div>
          <Link href="/new" className="btn btn-primary trips-new">
            <Plus size={16} />
            新建行程
          </Link>
        </header>

        {loaded && trips.length === 0 && (
          <section className="trips-empty" aria-label="还没有行程">
            <div className="trips-empty-mark" aria-hidden="true">
              行
            </div>
            <h2>还没有行程</h2>
            <p>
              说说想去哪、几天、预算多少。我们会先取真实世界的事实（POI / 营业时间 /
              通勤），再让模型在已核验的清单上排——不是一篇能看不能走的攻略。
            </p>
            <div className="trips-empty-actions">
              <Link href="/new" className="btn btn-primary">
                新建我的第一份行程
              </Link>
              <Link href="/about" className="btn btn-ghost">
                先看看它是怎么工作的
              </Link>
            </div>
            <p className="trips-empty-hint">
              想先看效果？新建页里可以打开一份真实生成的苏州 3 天示例，不用等。
            </p>
          </section>
        )}

        {loaded && trips.length > 0 && (
          <section className="trips-list" aria-label="行程列表">
            {trips.map((trip) => (
              <article className="trip-card" key={trip.shareId}>
                <Link className="trip-card-main" href={`/w/${trip.shareId}`}>
                  <span className="trip-card-city">{trip.city}</span>
                  <span className="trip-card-meta">
                    <CalendarDays size={14} />
                    {recentTripLabel(trip)}
                  </span>
                  {trip.summary && <span className="trip-card-summary">{trip.summary}</span>}
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

        {loaded && trips.length > 0 && (
          <Link href="/new" className="trips-add">
            <Plus size={16} />
            再规划一趟
          </Link>
        )}
      </div>
    </main>
  );
}
