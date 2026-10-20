"use client";

/** 每日人均花费迷你图表（SVG，真实数据） */

export function CostChart({ days }: { days: Array<{ day: number; dailyCostCny: number }> }) {
  if (days.length === 0) return null;

  // viewBox 宽度随天数自适应：天数少则图窄（移动端缩放比小、文字更清晰），
  // 天数多则图宽（每根柱留足空间，柱顶数字不重叠）。固定 640 宽在手机
  // （~340px）会缩到 0.53x，SVG 文字随之缩到 ~6px 看不清——这是重写的动机。
  const step = 92;
  const W = Math.max(200, days.length * step);
  const H = 128;
  const padT = 20; // 顶部留白：柱顶数字 + 平均线标签
  const padB = 24; // 底部留白：Day 标签
  const chartH = H - padT - padB;
  const values = days.map((d) => d.dailyCostCny);
  const max = Math.max(...values, 1);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const barW = Math.min(52, step - 26);
  // 平均线 y 夹取在图表安全区内（avg≤max 时本就不越界，夹取只为稳妥）
  const avgY = Math.min(H - padB, Math.max(padT, H - padB - (avg / max) * chartH));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="每日人均花费"
    >
      {/* 平均线 */}
      <line
        x1={8}
        y1={avgY}
        x2={W - 8}
        y2={avgY}
        style={{ stroke: "var(--accent)" }}
        strokeWidth="1"
        strokeDasharray="4 4"
        opacity="0.5"
      />
      <text
        x={W - 8}
        y={Math.max(11, avgY - 5)}
        textAnchor="end"
        fontSize="11"
        style={{ fill: "var(--accent)" }}
        opacity="0.9"
      >
        日均 ¥{Math.round(avg).toLocaleString()}
      </text>

      {days.map((d, i) => {
        const h = Math.max(3, (d.dailyCostCny / max) * chartH);
        const x = i * step + (step - barW) / 2; // 柱在所属列里居中
        const y = H - padB - h;
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={h}
              rx="4"
              style={{ fill: "var(--accent)" }}
              opacity="0.85"
            />
            <text
              x={x + barW / 2}
              y={y - 5}
              textAnchor="middle"
              fontSize="12"
              style={{ fill: "var(--ink-3)" }}
              fontWeight="600"
            >
              {d.dailyCostCny.toLocaleString()}
            </text>
            <text
              x={x + barW / 2}
              y={H - 7}
              textAnchor="middle"
              fontSize="11"
              style={{ fill: "var(--ink-4)" }}
            >
              Day {d.day}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
