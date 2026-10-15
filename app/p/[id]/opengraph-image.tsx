import { ImageResponse } from "next/og";
import { getJob } from "@/lib/jobs";

// 分享卡片图：分享到微信/Twitter 时渲染「城市 + 天数 + 概览」而非裸链接。
// 视觉对齐 globals.css 的深色 Premium 设计系统（--bg/--accent/--ink）。
//
// 中文字体：next/og 只内置 Geist（拉丁字形），实测 Satori 会回退到系统
// CJK 字体正常渲染中文，无需在仓库里搬一个几 MB 的字体文件。
//
// Satori 的两个硬约束（踩过，见 CHANGELOG）：
// 1. 多子节点的 div 必须显式 display:flex（判据是 children 非字符串，
//    数字/表达式都算）——所以这里每个 div 都带 display
// 2. 不支持 -webkit-line-clamp 行截断，摘要改为 JS 截断

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const alt = "行程分享";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  const plan = job?.status === "done" ? job.plan : null;

  const city = plan?.city ?? "行程";
  const days = plan?.days.length ?? 0;
  const spots = plan?.days.reduce((n, d) => n + d.spots.length, 0) ?? 0;
  const summary = plan?.summary ?? "这个行程不存在或已过期，去生成自己的行程吧";
  const summaryClamped = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#09090b",
        padding: "64px 72px",
        fontFamily: "sans-serif",
      }}
    >
      {/* 顶部：品牌行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ display: "flex", width: 10, height: 10, borderRadius: 999, background: "#fb923c" }} />
        <div style={{ display: "flex", fontSize: 26, color: "#a1a1aa", letterSpacing: 2 }}>AI 行程规划平台</div>
      </div>

      {/* 中部：城市 + 天数（主信息） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
          <div style={{ display: "flex", fontSize: 108, fontWeight: 700, color: "#fafafa", lineHeight: 1.05 }}>
            {city}
          </div>
          {days > 0 && (
            <div style={{ display: "flex", fontSize: 52, fontWeight: 600, color: "#fb923c" }}>
              {`${days} 天行程`}
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 32,
            color: "#d4d4d8",
            lineHeight: 1.5,
          }}
        >
          {summaryClamped}
        </div>
      </div>

      {/* 底部：数据行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
        {plan && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#fafafa" }}>
                {`¥${plan.totalCostCny.toLocaleString()}`}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: "#71717a" }}>人均总花费</div>
            </div>
            <div style={{ display: "flex", width: 1, height: 40, background: "rgba(255,255,255,0.16)" }} />
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#fafafa" }}>{`${spots}`}</div>
              <div style={{ display: "flex", fontSize: 22, color: "#71717a" }}>个行程点</div>
            </div>
          </>
        )}
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: "#71717a" }}>行程规划师</div>
      </div>
    </div>,
    { ...size },
  );
}
