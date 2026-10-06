import Link from "next/link";
import type { Metadata } from "next";
import { getJob } from "@/lib/jobs";
import { PlanView } from "@/components/PlanView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getPlan(id: string) {
  const job = getJob(id);
  if (!job || job.status !== "done" || !job.plan) return null;
  return job.plan;
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

// 分享页：/p/<jobId>——只读展示某个已生成行程（任务结果保留 2 小时）
export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const plan = await getPlan(id);

  if (!plan) {
    return (
      <main className="container">
        <div className="card">
          <h2>链接已失效</h2>
          <p className="muted">
            这个行程不存在或已过期（生成结果保留 2 小时，服务重启也会清除）。
          </p>
          <p>
            <Link href="/" style={{ color: "var(--accent)" }}>
              去生成自己的行程 →
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <p style={{ margin: "8px 0 16px" }}>
        <Link href="/" style={{ color: "var(--accent)", fontSize: 14, textDecoration: "none" }}>
          ← 行程规划师
        </Link>
      </p>
      <PlanView plan={plan} />
    </main>
  );
}
