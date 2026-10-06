import Link from "next/link";
import { getJob } from "@/lib/jobs";
import { PlanView } from "@/components/PlanView";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 分享页：/p/<jobId>——只读展示某个已生成行程（任务结果保留 2 小时）
export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = getJob(id);

  if (!job || job.status !== "done" || !job.plan) {
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
      <PlanView plan={job.plan} />
    </main>
  );
}
