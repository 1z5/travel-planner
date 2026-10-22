import { ImageResponse } from "next/og";

// 首页分享卡片图：链接被贴到微信/Twitter 时，别只显示裸链接。
// 与分享页 OG 同一套「纸面」语言：暖纸底 + 墨色 + 陶土橙细线。
//
// Satori 约束（见 app/p/[id]/opengraph-image.tsx 注释）：
// 多子节点容器必须显式 display:flex；中文依赖系统字体回退。
export const runtime = "nodejs";
export const alt = "行程规划师 — 每一份行程，都经得起核验";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#f6f5f2",
        padding: "64px 72px",
        fontFamily: "sans-serif",
        borderTop: "10px solid #c2410c",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            display: "flex",
            width: 44,
            height: 44,
            border: "2px solid #1a1815",
            borderRadius: 8,
            alignItems: "center",
            justifyContent: "center",
            fontSize: 26,
            color: "#1a1815",
          }}
        >
          行
        </div>
        <div style={{ display: "flex", fontSize: 26, color: "#45413b", letterSpacing: 2 }}>
          行程规划师 · TRAVEL PLANNER
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        <div
          style={{
            display: "flex",
            fontSize: 68,
            fontWeight: 700,
            color: "#1a1815",
            lineHeight: 1.15,
          }}
        >
          每一份行程，都经得起核验
        </div>
        <div style={{ display: "flex", fontSize: 28, color: "#625d55", lineHeight: 1.6 }}>
          先取真实世界的事实（POI / 营业时间 / 闭馆日 / 通勤），再让模型排行程。
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        {["POI 真实核验", "营业时间与闭馆", "真实通勤", "体检而非隐瞒"].map((t) => (
          <div
            key={t}
            style={{
              display: "flex",
              fontSize: 22,
              color: "#1a1815",
              border: "1px solid rgba(26,24,21,0.2)",
              borderRadius: 6,
              padding: "8px 14px",
            }}
          >
            {t}
          </div>
        ))}
        <div style={{ display: "flex", marginLeft: "auto", fontSize: 20, color: "#736d64" }}>
          数据来源 高德开放平台
        </div>
      </div>
    </div>,
    { ...size },
  );
}
