import Link from "next/link";
import type { Metadata } from "next";
import { resolvePlan } from "@/lib/plan-repo";
import { getStore } from "@/lib/store";
import { countClones } from "@/lib/clone-count";
import { PosterCover } from "@/components/PosterCover";
import { PlanView } from "@/components/PlanView";
import { TripAlert } from "@/components/TripAlert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getPlan(id: string) {
  // resolvePlan：新分享链接读持久化 Plan；旧 /p/<jobId> 链接在任务 TTL 内兜底可读
  return resolvePlan(id);
}

// 动态 OG：分享到微信/Twitter 时渲染「城市 N 天行程」卡片而非裸链接
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const plan = await getPlan(id);
  if (!plan) {
    return { title: "行程分享 - 行程规划师" };
  }
  const title = `${plan.city} ${plan.days.length} 天行程`;
  return {
    title: `${title} - 行程规划师`,
    description: plan.summary,
    openGraph: {
      title,
      description: plan.summary,
      type: "article",
      siteName: "行程规划师",
    },
    twitter: { card: "summary", title, description: plan.summary },
  };
}

// 分享页：/p/<share token>——只读展示已生成行程（持久化保存，不再 2 小时过期）。
// 旧 /p/<jobId> 链接也能打开（只读兜底）。
// ?edit=1 是「继续编辑」入口：PlanView 内部再校验本机是否生成过该行程
// （ownerCheck），防止只改 URL 就能改别人的行程。
export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string }>;
}) {
  const { id } = await params;
  const { edit } = await searchParams;
  const plan = await getPlan(id);

  // 克隆计数（分享页的社交证明）：复用度量闭环的 trip_cloned 事件，不需要
  // schema 迁移。0 次时 UI 整块不渲染——不编「已有 N 人克隆」。
  const cloneCount = plan
    ? countClones(
        await getStore().events.list({ name: "trip_cloned", shareId: id, limit: 1000 }),
        id,
      )
    : 0;

  if (!plan) {
    return (
      <main className="container">
        {/* 无效链接与 404 同一套语言：说清发生了什么、数据是否还在、下一步去哪 */}
        <div className="fault-page">
          <div className="fault-eyebrow">SHARE LINK · 链接已失效</div>
          <h1 className="fault-title">这个分享链接打不开</h1>
          <p className="fault-desc">
            这份行程不存在，或已被创建者删除。可能是链接地址有误——请让分享者重新发一次链接。
            已生成的行程本身是持久保存的，不会因为时间过期。
          </p>
          <div className="fault-actions">
            <Link href="/new" className="btn btn-primary btn-sm">
              新建一份行程
            </Link>
            <Link href="/about#faq" className="btn btn-sm">
              查看常见问题
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      {/* 页面元信息：面包屑 + 核验状态 + 数据来源。
          企业级分享页要让打开的人立刻知道「这是什么、可信度如何」。 */}
      <div className="page-meta">
        <Link href="/" className="page-back">
          ← 我的行程
        </Link>
        <span className="pm-sep" aria-hidden="true" />
        <span>分享行程</span>
        <span className="pm-sep" aria-hidden="true" />
        <span>
          {plan.city} · {plan.days.length} 天
        </span>
        <span className="pm-sep" aria-hidden="true" />
        <span className={plan.verification === "ok" ? "pm-ok" : "pm-muted"}>
          {plan.verification === "ok"
            ? "POI 已核验"
            : plan.verification === "mock"
              ? "MOCK 模式 · 未核验"
              : "核验状态未知"}
        </span>
        <span className="pm-sep" aria-hidden="true" />
        <span className="pm-source">数据来源 高德开放平台</span>
      </div>
      {/* 传播型 CTA：看到别人行程的人，一键生成自己的 */}
      <div className="share-cta">
        <div className="share-cta-text">
          <strong>也想去{plan.city}？</strong>
          {/* 口径必须与 /new 一致：真实模型 2-4 分钟（旧的「30 秒」做不到，
              面试/首次访问的人会以为页面卡死；「期间可离开」是 2026-10 起
              真实成立的行为——任务句柄落 localStorage，回来能续轮询） */}
          <span>输入你的时间和预算，2–4 分钟生成专属行程（期间可离开页面）</span>
        </div>
        <div className="share-cta-actions">
          <Link href={`/w/${id}`} className="btn btn-sm">
            在工作台打开
          </Link>
          {/* 竖版海报（1080×1920）：微信里长按即可保存转发，是分享裂变的物料。
              路由 /p/<id>/poster 与页面同源数据（lib/poster-model.ts）。 */}
          <a
            href={`/p/${id}/poster`}
            className="btn btn-sm"
            target="_blank"
            rel="noopener noreferrer"
          >
            保存海报
          </a>
          <Link href="/new" className="share-cta-btn">
            生成我的行程 →
          </Link>
        </div>
        {cloneCount > 0 && <p className="share-clone-count">{cloneCount} 人克隆过这份行程</p>}
      </div>

      {/* 切片1 · 海报级分享页：传播飞轮的「值得截图」封面（见 components/PosterCover.tsx）。
          纯增量插在 TripAlert 之前，现有元素与顺序一律不动。 */}
      <PosterCover plan={plan} shareId={id} />

      <TripAlert plan={plan} />

      <PlanView plan={plan} shareId={id} editable={edit === "1"} ownerCheck hideCover />
    </main>
  );
}
