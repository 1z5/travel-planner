import Link from "next/link";
import type { Metadata } from "next";
import { resolvePlan } from "@/lib/plan-repo";
import { TodayView } from "@/components/TodayView";

// 「行中模式」页：/t/<share token>
//
// 为什么单独开一个页面而不是复用 /p/<token>：/p 是「规划视角」——整份行程
// 铺开（分天地图/预算/预警/编辑工具），信息量按「做决策」设计；而旅行当天
// 用户站在路口打开手机，要的是「执行视角」：现在在哪、下一站、怎么走、
// 天气如何。两者信息架构相反，强行同一页只会让当天的第一屏继续过载。
//
// 同样用 resolvePlan：新链接读持久化 Plan，旧 /t/<jobId> 在任务 TTL 内兜底可读
// （与 /p 同口径，链接生命周期不因入口不同而缩短）。
export const runtime = "nodejs";
// 今日视图依赖「今天」与最新行程（可能刚被一键改室内），不能静态化；
// 也不能被 CDN 缓存成昨天的时间轴。
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
    // 失效链接也要给标题：手机返回栈/分享卡片里不能是一串裸 404 语义
    return { title: "链接已失效 - 行中助手" };
  }
  // 标题按任务书固定为「<城市> 行中助手」：这个页面被用户加到手机桌面时，
  // 图标下显示的就是它，带上城市才能一眼区分多段行程。
  return {
    title: `${plan.city} 行中助手`,
    description: plan.summary,
  };
}

export default async function TodayPage({ params }: { params: Promise<{ id: string }> }) {
  // Next 16：params 是 Promise，必须 await（与 /p/[id] 一致）
  const { id } = await params;
  const plan = await getPlan(id);

  if (!plan) {
    // 措辞与分享页（/p/[id]）保持一致：同一个链接失效原因，不该因为入口不同
    // 给出两套说法。不承诺「过期时间」——新 Plan 并不会过期。
    return (
      <main className="container">
        <div className="card">
          <h2>链接已失效</h2>
          <p className="muted">
            这个行程不存在或已被删除。可能是链接地址有误，或创建者删除了行程。
          </p>
          <p>
            <Link href="/new" className="btn-link">
              新建一份行程 →
            </Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      {/* 今日视图的状态全部由客户端按「本地时区」判定（SSR 的服务端时区可能
          与用户手机不同），所以这里只做数据读取与页面骨架。 */}
      {/* 演示行程只读：后端写操作会 403，这里套 .tc-demo-lock 隐藏「重新安排/改室内」等按钮 */}
      <div className={plan.demo ? "tc-demo-lock" : undefined}>
        <TodayView plan={plan} shareId={id} />
      </div>
    </main>
  );
}
