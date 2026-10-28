import type { Metadata } from "next";
import Link from "next/link";
import { resolvePlan } from "@/lib/plan-repo";
import { stampPlan } from "@/lib/verify/stamp";
import { reportHeadline } from "@/lib/trip-check-report";
import { TripCheckReport } from "@/components/TripCheckReport";
import { TripCheckShareActions } from "@/components/TripCheckShareActions";
import type { FactsVerdict } from "@/lib/verify/types";

// ============================================================
// 可分享的体检报告页：/p/<shareId>/check（RSC）
//
// 为什么单独一页而不是塞进分享页：分享页的主语是「行程」；这一页的主语是
// 「可复算的证据」——两轴结论、规则级证据、可复算凭据，适合作为独立工件被
// 转发/存证。数据与分享页/工作台/海报同源（stampPlan → 同一 verifyDocument +
// credentialOf），所以三处永远不会说两套话。
//
// 展示层复用 components/TripCheckReport（/verify 同一套 tc-* 设计语言）；
// 页面额外提供传播动作（复制纯文本/JSON、下载、海报）与返回分享页/工作台的导航。
// MOCK/未核验由报告本身如实呈现（未核验 ≠ 没问题），页面不额外美化。
// ============================================================

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACTS_LABEL: Record<FactsVerdict["state"], string> = {
  verified: "已核验",
  partial: "部分核验",
  unverified: "未核验",
  inconclusive: "无可核验点位",
};

async function getPlan(id: string) {
  return resolvePlan(id);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const plan = await getPlan(id);
  if (!plan) return { title: "行程体检报告 — 行程规划师" };
  const stamp = stampPlan(plan, { id });
  const headline = reportHeadline(stamp.report);
  const title = `${plan.city} ${plan.days.length} 天行程体检报告`;
  return {
    title: `${title} — 行程规划师`,
    description: `${headline}。两轴结论、规则级证据与可复算凭据。`,
    openGraph: {
      title,
      description: headline,
      type: "article",
      siteName: "行程规划师",
    },
    twitter: { card: "summary", title, description: headline },
  };
}

export default async function CheckReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await getPlan(id);

  if (!plan) {
    return (
      <main className="container">
        <div className="fault-page">
          <div className="fault-eyebrow">TRIP CHECK · 报告链接已失效</div>
          <h1 className="fault-title">这份体检报告打不开</h1>
          <p className="fault-desc">
            对应的行程不存在或已被删除。报告是从行程实时复算出来的，不单独存副本；请让分享者
            重新发一次行程链接。
          </p>
          <div className="fault-actions">
            <Link href="/" className="btn btn-primary btn-sm">
              回到我的行程
            </Link>
            <Link href="/new" className="btn btn-sm">
              新建一份行程
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const stamp = stampPlan(plan, { id });
  // 页面统一用「带回执的报告」：TripCheckReport 的凭据区块读取 report.credential，
  // 而引擎报告本身不带凭据（凭据由 stampPlan 签发），这里显式附加同一份凭据。
  const report = { ...stamp.report, credential: stamp.credential };
  const headline = reportHeadline(report);
  const factsState = report.verdict.facts.state;
  const factsLabel = FACTS_LABEL[factsState] ?? factsState;
  const siteBase = process.env.NEXT_PUBLIC_SITE_URL ?? process.env.RENDER_EXTERNAL_URL;
  const reportUrl = siteBase ? `${siteBase}/p/${id}/check` : undefined;

  return (
    <main className="container tc-report-page">
      <div className="page-meta">
        <Link href={`/p/${id}`} className="page-back">
          ← 返回行程分享页
        </Link>
        <span className="pm-sep" aria-hidden="true" />
        <span>行程体检报告</span>
        <span className="pm-sep" aria-hidden="true" />
        <span>
          {plan.city} · {plan.days.length} 天
        </span>
        <span className="pm-sep" aria-hidden="true" />
        <span className={factsState === "verified" ? "pm-ok" : "pm-muted"}>
          {factsLabel}
          {factsState !== "verified" ? " · 未核验 ≠ 没问题" : ""}
        </span>
      </div>

      <header className="tc-report-page-hero">
        <p className="about-eyebrow">
          <span className="eyebrow-dot" aria-hidden="true" />
          Trip Check · 可复算的体检报告
        </p>
        <h1 className="tc-report-page-title">
          {plan.city} · {plan.days.length} 天行程体检
        </h1>
        <p className="tc-report-page-headline">{headline}</p>
        <p className="tc-report-page-lede">
          这份报告由这份分享行程实时复算（同一个确定性引擎、同一份文档、同一版本规则），
          不是固化的历史结论；两轴分开、每条问题带规则 ID 与可对账证据，凭据 ID 可被任何人
          独立复算。判定之后真实世界的变化（营业时间调整、临时闭馆等）不在报告覆盖范围内。
        </p>
        <TripCheckShareActions
          report={report}
          credentialId={stamp.credential.id}
          shareId={id}
          reportUrl={reportUrl}
        />
      </header>

      <TripCheckReport report={report} />

      <p className="tc-report-page-foot">
        <Link href={`/p/${id}`}>行程分享页</Link>
        <span aria-hidden="true">·</span>
        <Link href={`/w/${id}?view=check`}>在工作台查看体检记录</Link>
        <span aria-hidden="true">·</span>
        <Link href="/verify">在开放体检台体检任意行程</Link>
      </p>
    </main>
  );
}
