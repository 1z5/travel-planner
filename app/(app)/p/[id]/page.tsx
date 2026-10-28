import Link from "next/link";
import type { Metadata } from "next";
import { resolvePlan } from "@/lib/plan-repo";
import { getStore } from "@/lib/store";
import { countClones } from "@/lib/clone-count";
import { PosterCover } from "@/components/PosterCover";
import { PlanView } from "@/components/PlanView";
import { TripAlert } from "@/components/TripAlert";
import { WishlistButton } from "@/components/WishlistButton";
import { DemoReadOnlyNote } from "@/components/DemoReadOnlyNote";
import { stampPlan } from "@/lib/verify/stamp";

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

  // 行程体检凭据（Trip Check v0.1）：把这份行程转成开放文档 → 确定性判定 → 可复算凭据。
  // 为什么在分享页露：分享页是「给别人看的工件」，正是「可对账证据」最该出现的地方
  // （调研结论：平台不背责任 → 供给方/分享者需要能自证行程没问题的凭证）。
  // 实现在 lib/verify/stamp.ts（RSC 渲染体不直接调 Date/哈希，见该文件注释）；
  // MOCK/未核验会如实显示，不会被包装成「真实核验」。
  // schema.org TouristTrip 同时输出：搜索引擎/聚合器无需接 API 就能结构化读取行程。

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

  // 体检工件在「确认 plan 存在」之后计算，避免把 null 分支也卷进判定/凭据逻辑。
  const siteBase = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.RENDER_EXTERNAL_URL;
  const stamp = stampPlan(plan, siteBase ? { id, url: `${siteBase}/p/${id}` } : { id });
  const checkFactsLabel: Record<string, string> = {
    verified: "已核验",
    partial: "部分核验",
    unverified: "未核验",
    inconclusive: "无可核验点位",
  };

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
        {plan.tripCheck && (
          <>
            <span className="pm-sep" aria-hidden="true" />
            <span className="pm-ok">已确定性修复</span>
          </>
        )}
        {plan.demo && (
          <>
            <span className="pm-sep" aria-hidden="true" />
            <span className="pm-muted">示例行程 · 只读（可克隆）</span>
          </>
        )}
      </div>

      {/* 演示行程只读提示：后端会对 demo 行程的写操作 403，这里提前说清楚（可克隆） */}
      <DemoReadOnlyNote plan={plan} variant="share" />

      {/* 结构化数据（schema.org TouristTrip）：搜索引擎/聚合器可直接读取行程，
          不需要接我们的 API。内容只含文档已有事实，不含核验结论（schema.org 没有对应词汇）。 */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: stamp.jsonLdInline }} />

      {/* 行程体检凭据：两轴结论 + 可复算 ID + 跳转开放报告。
          故意放在分享页最上方——「可对账的证据」就是给别人看的第一件东西。 */}
      <section className="card" aria-label="行程体检凭据">
        <div className="card-body">
          <p className="muted">Trip Check · 行程体检凭据（开放标准 v0.1）</p>
          <p>
            结构自洽性 <strong>{stamp.report.verdict.consistency.grade}</strong>（
            {stamp.report.verdict.consistency.score} 分） · 事实核验{" "}
            <strong>
              {checkFactsLabel[stamp.report.verdict.facts.state] ??
                stamp.report.verdict.facts.state}
            </strong>
            {stamp.report.verdict.facts.state !== "verified" && "（未核验 ≠ 没问题）"} · 凭据{" "}
            <code>{stamp.credential.id}</code>
          </p>
          <Link href={`/verify?share=${id}`} className="btn-link">
            在开放体检台查看完整报告 / 复算凭据 →
          </Link>
          {/* 可传播的体检报告工件：独立报告页 + 1080×1920 竖版海报（同源 stamp） */}
          <p className="muted">
            <Link href={`/p/${id}/check`} className="btn-link">
              查看体检报告 →
            </Link>
            <span aria-hidden="true"> · </span>
            <a
              href={`/p/${id}/check/poster`}
              className="btn-link"
              target="_blank"
              rel="noopener noreferrer"
            >
              保存体检海报 →
            </a>
          </p>
          {plan.tripCheck && (
            <p className="muted">
              已在第 {plan.tripCheck.repairCount ?? 1} 次确定性修复中写入新版本 · 修复链：
              <code>{plan.tripCheck.parentCredentialId ?? "—"}</code> →{" "}
              <code>{plan.tripCheck.credentialId}</code>
              <br />
              <Link href={`/w/${id}?view=check`} className="btn-link">
                在工作台查看体检记录 →
              </Link>
            </p>
          )}
        </div>
      </section>

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
          {/* 愿望清单（B3）：先记下来、以后再排。克隆是「现在就排」，两者互补。 */}
          <WishlistButton
            shareId={id}
            city={plan.city}
            days={plan.days.length}
            startDate={plan.startDate}
            summary={plan.summary}
          />
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
