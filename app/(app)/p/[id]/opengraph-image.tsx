import { ImageResponse } from "next/og";
import { resolvePlan } from "@/lib/plan-repo";
import { formatCny, summarizeBudget } from "@/lib/budget";

// 分享卡片图：分享到微信/Twitter 时渲染「城市 + 天数 + 概览」而非裸链接。
// 视觉对齐 globals.css 的「纸上行程」设计系统（暖纸底 / 墨色 / 陶土橙）——
// 分享卡片是传播物，必须和点开后的页面是同一套纸面语言。
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
  // 同分享页：新 token 读持久化 Plan，旧 jobId 链接兜底读任务（OG 不回归）
  const plan = await resolvePlan(id);

  const city = plan?.city ?? "行程";
  const days = plan?.days.length ?? 0;
  const spots = plan?.days.reduce((n, d) => n + d.spots.length, 0) ?? 0;
  const summary = plan?.summary ?? "这个行程不存在或已过期，去生成自己的行程吧";
  const summaryClamped = summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
  // 预算口径与页面海报 / 预算透视同源（lib/budget.ts 的逐项合计 + 四态阈值）：
  // 分享卡片上的使用率必须和打开页面看到的数字一致，两处说两套话比不说更糟。
  // 行程没有记录预算（旧数据 / 早期分享）时 usedPct 为 undefined——整行不渲染，不猜。
  const budget = plan ? summarizeBudget(plan) : null;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f6f0e4",
        padding: "64px 72px",
        fontFamily: "sans-serif",
        borderTop: "10px solid #c2410c",
      }}
    >
      {/* 顶部：品牌行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            display: "flex",
            width: 10,
            height: 10,
            borderRadius: 999,
            background: "#c2410c",
          }}
        />
        <div style={{ display: "flex", fontSize: 26, color: "#7c7160", letterSpacing: 2 }}>
          AI 行程规划平台
        </div>
      </div>

      {/* 中部：城市 + 天数（主信息） */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
          <div
            style={{
              display: "flex",
              fontSize: 108,
              fontWeight: 700,
              color: "#221d16",
              lineHeight: 1.05,
            }}
          >
            {city}
          </div>
          {days > 0 && (
            <div style={{ display: "flex", fontSize: 52, fontWeight: 600, color: "#c2410c" }}>
              {`${days} 天行程`}
            </div>
          )}
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 32,
            color: "#4b4337",
            lineHeight: 1.5,
          }}
        >
          {summaryClamped}
        </div>
        {/* 预算行（切片1 增量）：只有有效预算才出现。暖橙强调色与卡片上的
            城市主标题形成呼应，让「预算」在微信/Twitter 卡片里第一眼可见。 */}
        {budget?.usedPct !== undefined && (
          <div
            style={{
              display: "flex",
              fontSize: 32,
              fontWeight: 600,
              color: "#c2410c",
            }}
          >
            {`预算 ${formatCny(budget.budget ?? 0)} · 用掉 ${budget.usedPct}%`}
          </div>
        )}
      </div>

      {/* 底部：数据行 */}
      <div style={{ display: "flex", alignItems: "center", gap: 48 }}>
        {plan && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#221d16" }}>
                {`¥${plan.totalCostCny.toLocaleString()}`}
              </div>
              <div style={{ display: "flex", fontSize: 22, color: "#7c7160" }}>人均总花费</div>
            </div>
            <div
              style={{
                display: "flex",
                width: 1,
                height: 40,
                background: "rgba(34,29,22,0.18)",
              }}
            />
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <div
                style={{ display: "flex", fontSize: 40, fontWeight: 700, color: "#221d16" }}
              >{`${spots}`}</div>
              <div style={{ display: "flex", fontSize: 22, color: "#7c7160" }}>个行程点</div>
            </div>
          </>
        )}
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 22, color: "#7c7160" }}>
          行程规划师
        </div>
      </div>
    </div>,
    { ...size },
  );
}
