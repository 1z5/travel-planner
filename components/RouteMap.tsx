"use client";

export interface RouteStop {
  name: string;
  type: string;
}

/**
 * 每日路线示意图：把当天的行程点画成一条编号路线。
 * 注意这是示意图（非地理精确）——地理坐标版在接入高德 key 后升级。
 *
 * 浅色杂志风：改成「编辑式路线条」——一条水平基线 + 编号节点 + 交替标签。
 * 原来的正弦曲线在纸面底色上像随手画的波浪线，不像产品；水平基线更克制，
 * 也不冒充地理精确（真实地图由 RealMap 负责，这里只是顺序示意）。
 */
export function RouteMap({ stops }: { stops: RouteStop[] }) {
  if (stops.length === 0) return null;

  // viewBox 宽度随站数自适应：站少则图窄（移动端缩放比小、编号和站名更清晰），
  // 与 CostChart 同一思路。原固定 720 在手机（~340px）缩到 0.47x，字缩到看不清。
  const step = 104;
  const n = stops.length;
  const W = Math.max(300, n * step);
  const H = 124;
  const lineY = 52;

  // 锚点：水平均匀分布；标签上下交替，避免相邻站名互相压字
  const anchors = stops.map((s, i) => ({
    ...s,
    x: n === 1 ? W / 2 : (i * (W - 80)) / (n - 1) + 40,
    y: lineY,
  }));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="当日路线示意图"
    >
      {/* 水平基线：一条细墨线代表动线顺序（不冒充地理路径）。 */}
      <line
        x1={40}
        y1={lineY}
        x2={W - 40}
        y2={lineY}
        style={{ stroke: "var(--line-strong)" }}
        strokeWidth="1.5"
      />

      {/* 站点：编号圆点 + 上下交替标签（避免相邻站名压字）。 */}
      {anchors.map((a, i) => {
        const above = i % 2 === 0;
        const labelY = above ? lineY - 22 : lineY + 30;
        const name = a.name.length > 9 ? `${a.name.slice(0, 8)}…` : a.name;
        // 边缘标签钳制：靠边的站名改用 start/end 锚点，防止被 viewBox 裁切
        const nearLeft = a.x < 70;
        const nearRight = a.x > W - 70;
        const labelX = nearLeft ? Math.max(a.x, 30) : nearRight ? Math.min(a.x, W - 30) : a.x;
        const anchor = nearLeft ? "start" : nearRight ? "end" : "middle";
        return (
          <g key={i}>
            <circle
              cx={a.x}
              cy={lineY}
              r="12"
              style={{ fill: "var(--surface)", stroke: "var(--accent)" }}
              strokeWidth="1.8"
            />
            <text
              x={a.x}
              y={lineY + 4.2}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              style={{ fill: "var(--ink)" }}
            >
              {i + 1}
            </text>
            <text
              x={labelX}
              y={labelY}
              textAnchor={anchor}
              fontSize="12.5"
              style={{ fill: "var(--ink-2)" }}
            >
              {name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
