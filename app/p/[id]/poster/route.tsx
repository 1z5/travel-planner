import { ImageResponse } from "next/og";
import { resolvePlan } from "@/lib/plan-repo";
import { buildPosterModel } from "@/lib/poster-model";

// 竖版行程海报：1080×1920，供「保存海报 → 微信发朋友」。
//
// 为什么单独一个路由而不是复用 OG 图：OG 是 1200×630 横版、给爬虫看的；
// 这是给**人**保存传播的物料，需要竖版、更大的标题、可点开链接的提示。
// 两者数据同源（buildPosterModel / summarizeBudget），视觉同一套纸面语言。
//
// Satori 硬约束（与 opengraph-image.tsx 同一套教训，改这里前先读那边注释）：
// 1. 多子节点的 div 必须显式 display:flex（数字/表达式都算 children）；
// 2. 不支持 -webkit-line-clamp，长文本 JS 截断；
// 3. 中文回退系统 CJK 字体，不在仓库里搬字体文件。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = { width: 1080, height: 1920 };
export const contentType = "image/png";

const INK = "#221d16";
const PAPER = "#f6f0e4";
const ACCENT = "#c2410c";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 与分享页/OG 同口径：新 token 读持久化 Plan，旧 jobId 链接兜底
  const plan = await resolvePlan(id);
  // 行程不存在 → 404：不渲染「假行程」海报（传播物上的假数据传得最远）
  if (!plan) {
    return new Response("行程不存在", { status: 404 });
  }

  const m = buildPosterModel(plan);
  const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: PAPER,
        padding: "88px 84px",
        fontFamily: "serif",
        color: INK,
        borderTop: `14px solid ${ACCENT}`,
      }}
    >
      {/* 顶部：品牌 + 核验状态 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", width: 14, height: 14, background: ACCENT }} />
          <div style={{ display: "flex", fontSize: 30, letterSpacing: 2 }}>行程规划师</div>
        </div>
        <div style={{ display: "flex", fontSize: 34, color: "#6b5f52" }}>{m.verifyLine}</div>
      </div>

      {/* 中部：城市/天数/日期 + KPI + 看点 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 44 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", fontSize: 120, lineHeight: 1.1 }}>{m.city}</div>
          <div style={{ display: "flex", fontSize: 44, color: "#6b5f52" }}>
            {m.daysText}
            {m.dateText ? ` · ${m.dateText}` : ""}
          </div>
        </div>

        <div style={{ display: "flex", gap: 20 }}>
          {m.kpis.map((k) => (
            <div
              key={k.label}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                flex: 1,
                borderTop: `3px solid ${INK}`,
                paddingTop: 16,
              }}
            >
              <div style={{ display: "flex", fontSize: 44 }}>{k.value}</div>
              <div style={{ display: "flex", fontSize: 24, color: "#6b5f52" }}>{k.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {m.highlights.map((h) => (
            <div
              key={`${h.time}-${h.name}`}
              style={{ display: "flex", alignItems: "baseline", gap: 20 }}
            >
              <div style={{ display: "flex", fontSize: 28, color: ACCENT, width: 110 }}>
                {h.time}
              </div>
              <div style={{ display: "flex", fontSize: 36 }}>{clamp(h.name, 14)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* 底部：预算行 + 品牌 + 数据来源 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {m.budgetLine ? (
          <div style={{ display: "flex", fontSize: 32, color: "#6b5f52" }}>{m.budgetLine}</div>
        ) : null}
        <div style={{ display: "flex", fontSize: 28 }}>{m.brandLine}</div>
        <div style={{ display: "flex", fontSize: 22, color: "#8a7d6c" }}>
          POI / 营业时间 / 通勤来自高德开放平台
        </div>
      </div>
    </div>,
    size,
  );
}
