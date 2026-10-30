import Link from "next/link";
import type { Metadata } from "next";
import { resolvePlan } from "@/lib/plan-repo";
import { TripReport } from "@/components/TripReport";

// 「旅程报告」页：/r/<share token>——出行结束后的 post-trip 传播物。
//
// 为什么与 /p、/t 三页并存而不是合并：/p 是规划视角（决策），/t 是行中执行
// 视角（当天），/r 是回顾视角（传播/留存）。同一份 Plan 的三种叙事，信息
// 架构各自独立；报告页刻意去掉编辑入口与预警，只留「值得截图」的统计。
//
// 链接口径与 /p、/t 一致：resolvePlan 先读持久化 Plan（新链接），旧 jobId
// 链接在任务 TTL 内兜底可读——报告链接的生命周期不因入口不同而缩短。
export const runtime = "nodejs";
// 报告页含「今天/待出发/进行中」这类相对时间判定，且行程可能刚被改过，
// 不能静态化、也不能被 CDN 缓存成过期结论。
export const dynamic = "force-dynamic";

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
  if (!plan) {
    // 失效链接也要给标题：分享卡片/返回栈里不能是一串裸 404 语义
    return { title: "链接已失效 - 旅行报告" };
  }
  const days = Array.isArray(plan.days) ? plan.days.length : 0;
  const title = `${plan.city} ${days} 天旅行报告`;
  return {
    title: `${title} - 行程规划师`,
    // description 用行程摘要：报告页分享出去时，卡片预览里至少能看到这趟
    // 旅行是什么，而不是一句空泛的「AI 行程」。
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

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16：params 是 Promise，必须 await（与 /p/[id]、/t/[id] 一致）
  const { id } = await params;
  const plan = await getPlan(id);

  if (!plan) {
    // 措辞与分享页（/p/[id]）保持一致：同一个链接失效原因，不该因为入口
    // 不同给出两套说法。不承诺「过期时间」——持久化 Plan 并不会过期。
    return (
      <main className="container">
        <div className="fault-page">
          <div className="fault-eyebrow">TRAVEL REPORT · 链接已失效</div>
          <h1 className="fault-title">这份旅程报告打不开</h1>
          <p className="fault-desc">
            报告对应的行程不存在，或已被创建者删除。可能是链接地址有误——请让分享者重新发一次链接。
          </p>
          <div className="fault-actions">
            <Link href="/new" className="btn btn-primary btn-sm">
              新建一份行程
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="container at-evidence-page at-report-page">
      <div className="page-meta">
        <Link href="/" className="page-back">
          ← 我的行程
        </Link>
        <span className="pm-sep" aria-hidden="true" />
        <span>旅程报告</span>
        <span className="pm-sep" aria-hidden="true" />
        <span>
          {plan.city} · {plan.days.length} 天
        </span>
        <span className="pm-sep" aria-hidden="true" />
        <span className={plan.verification === "ok" ? "pm-ok" : "pm-muted"}>
          {plan.verification === "ok" ? "POI 已核验" : "数据未核验"}
        </span>
        <span className="pm-sep" aria-hidden="true" />
        <span className="pm-source">数据来源 高德开放平台</span>
      </div>
      {/* 状态（upcoming/ongoing/past）由 TripReport 在客户端按本地时区判定，
          SSR 只渲染与日期无关的内容——与行中模式 /t 同一模式。 */}
      <TripReport plan={plan} shareId={id} />
    </main>
  );
}
