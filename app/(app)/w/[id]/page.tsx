import type { Metadata } from "next";
import Link from "next/link";
import { resolvePlan } from "@/lib/plan-repo";
import { TripWorkspace } from "@/components/TripWorkspace";

// Trip Workspace：一个行程的工作台（规划 / 地图 / 今日三个镜头）。
// 入口在「我的行程」卡片；分享页 /p/[id] 仍是对外只读工件，并可跳到这里。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const plan = await resolvePlan(id);
  if (!plan) return { title: "行程不存在 — 行程规划师" };
  return { title: `${plan.city} · ${plan.days.length} 天行程 — 我的行程` };
}

export default async function WorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plan = await resolvePlan(id);

  if (!plan) {
    return (
      <main className="container">
        <div className="fault-page">
          <div className="fault-eyebrow">WORKSPACE · 链接已失效</div>
          <h1 className="fault-title">这个行程打不开</h1>
          <p className="fault-desc">
            行程不存在或已被删除。可能是链接有误，或这份行程还没生成完成。
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

  return (
    <main className="trip-workspace">
      <TripWorkspace plan={plan} shareId={id} />
    </main>
  );
}
