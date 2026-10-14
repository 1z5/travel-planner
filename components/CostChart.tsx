"use client";

/** 每日人均花费迷你图表（SVG，真实数据） */

export function CostChart({ days }: { days: Array<{ day: number; dailyCostCny: number }> }) {
  if (days.length === 0) return null;

  const W = 640;
  const H = 120;
  const padB = 22;
  const values = days.map((d) => d.dailyCostCny);
  const max = Math.max(...values, 1);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const barW = Math.min(56, (W - 40) / days.length - 18);
  const step = (W - 40) / days.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
         role="img" aria-label="每日人均花费">
      {/* 平均线 */}
      <line x1={20} y1={H - padB - (avg / max) * (H - padB - 16)} x2={W - 20}
            y2={H - padB - (avg / max) * (H - padB - 16)}
            stroke="#fb923c" strokeWidth="1" strokeDasharray="4 4" opacity="0.6" />
      <text x={W - 20} y={H - padB - (avg / max) * (H - padB - 16) - 5}
            textAnchor="end" fontSize="10" fill="#fb923c" opacity="0.8">
        日均 ¥{Math.round(avg).toLocaleString()}
      </text>

      {days.map((d, i) => {
        const h = Math.max(3, (d.dailyCostCny / max) * (H - padB - 16));
        const x = 20 + i * step + (step - barW) / 2;
        const y = H - padB - h;
        return (
          <g key={d.day}>
            <rect x={x} y={y} width={barW} height={h} rx="4" fill="rgba(251, 146, 60, 0.85)" />
            <text x={x + barW / 2} y={y - 5} textAnchor="middle" fontSize="10.5"
                  fill="#a1a1aa" fontWeight="600">
              {d.dailyCostCny.toLocaleString()}
            </text>
            <text x={x + barW / 2} y={H - 6} textAnchor="middle" fontSize="10.5" fill="#71717a">
              Day {d.day}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
