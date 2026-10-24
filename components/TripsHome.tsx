"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, CalendarDays, Plus, Trash2 } from "lucide-react";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
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

        {/* 新用户首屏：产品主张 + 看得见的记忆点 + 唯一主 CTA。
            旧版是「空房间」——只有「还没有行程」加一段说明，新用户 30 秒内
            既不知道这是什么产品，也记不住凭什么不一样。 */}
        {loaded && trips.length === 0 && (
          <section className="firstscreen" aria-label="产品首屏">
            <p className="firstscreen-eyebrow">
              <span className="eyebrow-dot" aria-hidden="true" />
              事实先行 · 生成前先核验真实世界
            </p>
            <h1 className="firstscreen-title">先核验真实世界，再排行程</h1>
            <p className="firstscreen-lede">
              输入目的地、时间与预算，我们先用高德取真实 POI、营业时间与通勤，再让模型排成
              <strong>走得通的行程</strong>
              ——绕路、闭馆、时间接不上的问题在出发前就标出来，改不改由你决定。
            </p>
            <div className="firstscreen-cta">
              <Link href="/new" className="btn btn-primary firstscreen-btn">
                说说你想去哪
              </Link>
              <Link href="/new?sample=1" className="btn btn-ghost">
                看一份真实示例
              </Link>
            </div>

            {/* 记忆点：同一份真实生成示例 + 它被体检拦下的问题。
                数据全部来自 SAMPLE_PLAN（verified:false，MOCK 高德），
                所以示例卡如实标注「POI 未验真」——不拿 MOCK 数据冒充已核验。 */}
            {/* 记忆点：同一份真实生成示例 + 它被体检拦下的问题。数据全部来自
                SAMPLE_PLAN（verified:false，MOCK 高德），示例卡如实标注
                「POI 未验真」——不拿 MOCK 数据冒充已核验。 */}
            <div className="firstscreen-evidence">
              <article className="fs-card">
                <div className="fs-card-head">
                  <span className="fs-card-tag">真实生成的示例</span>
                  <span className="fs-card-note">MOCK 高德 · POI 未验真</span>
                </div>
                <h2 className="fs-card-title">
                  {SAMPLE_PLAN.city} · {SAMPLE_PLAN.days.length} 天
                </h2>
                <p className="fs-card-meta">
                  {SAMPLE_PLAN.days.reduce((n, d) => n + d.spots.length, 0)} 个点位 · 人均 ¥
                  {SAMPLE_PLAN.totalCostCny.toLocaleString("zh-CN")}
                </p>
                <p className="fs-card-body">{SAMPLE_PLAN.summary}</p>
                <Link href="/new?sample=1" className="fs-card-link">
                  打开完整示例 →
                </Link>
              </article>

              <article className="fs-card fs-card-warn">
                <div className="fs-card-head">
                  <span className="fs-card-tag">被体检拦下的问题</span>
                  <span className="fs-card-note">取自同一份示例</span>
                </div>
                <h2 className="fs-card-title">出发前就被标出来</h2>
                <ul className="fs-warn-list">
                  {SAMPLE_PLAN.warnings.slice(0, 2).map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
                <p className="fs-card-body">
                  能修的「一键顺延 / 重排」直接修，修不了的老实说修不了——不制造假动作。
                </p>
              </article>
            </div>

            <ul className="firstscreen-points">
              <li>
                <strong>事实先行</strong>
                <span>POI / 营业时间 / 通勤来自高德实时检索，不是模型记忆</span>
              </li>
              <li>
                <strong>可改不坏</strong>
                <span>换一个 / 一句话改一天 / 拖拽重排，硬约束不会被删掉</span>
              </li>
              <li>
                <strong>带得走</strong>
                <span>行程持久保存，分享链接不过期，出行当天有专属视图</span>
              </li>
            </ul>
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
