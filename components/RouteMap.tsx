"use client";

// 每种行程点的语义色（固定调色板，与主题 accent 无关——每种类型一个区分色）。
// 亮enough 在暗色底上也清晰。
const TYPE_COLOR: Record<string, string> = {
  sight: "#38bdf8",
  food: "#fbbf24",
  hotel: "#a78bfa",
  transport: "#94a3b8",
  shopping: "#f472b6",
  activity: "#34d399",
};

export interface RouteStop {
  name: string;
  type: string;
}

/**
 * 每日路线示意图：把当天的行程点画成一条编号路线。
 * 注意这是示意图（非地理精确）——地理坐标版在接入高德 key 后升级。
 *
 * 暗色主题：整站是暗色 Premium，示意图原来用亮蓝渐变底 + 白圆点，在暗色结果页里
 * 像一块亮补丁。改为暗色底（var(--surface-solid)）+ 各类型语义色，与整体一致。
 */
export function RouteMap({ stops }: { stops: RouteStop[] }) {
  if (stops.length === 0) return null;

  // viewBox 宽度随站数自适应：站少则图窄（移动端缩放比小、编号和站名更清晰），
  // 与 CostChart 同一思路。原固定 720 在手机（~340px）缩到 0.47x，字缩到看不清。
  const step = 104;
  const n = stops.length;
  const W = Math.max(300, n * step);
  const H = 156;
  const amp = 26; // 纵向起伏幅度（配合 H/labelY 保证标签不越界）
  const cy = H / 2;

  // 锚点：横向均匀分布，纵向正弦起伏（避免连线呆板）
  const anchors = stops.map((s, i) => ({
    ...s,
    x: n === 1 ? W / 2 : (i * (W - 80)) / (n - 1) + 40,
    y: cy + Math.sin(i * 1.35) * amp,
  }));

  // 平滑路径（Catmull-Rom 转三次贝塞尔）
  let path = `M ${anchors[0].x} ${anchors[0].y}`;
  for (let i = 0; i < anchors.length - 1; i++) {
    const p0 = anchors[Math.max(0, i - 1)];
    const p1 = anchors[i];
    const p2 = anchors[i + 1];
    const p3 = anchors[Math.min(anchors.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    path += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      role="img"
      aria-label="当日路线示意图"
    >
      {/* 暗色底 */}
      <rect width={W} height={H} style={{ fill: "var(--surface-solid)" }} />

      {/* 装饰网格点 */}
      {Array.from({ length: 12 }).map((_, i) => (
        <circle
          key={i}
          cx={40 + i * ((W - 80) / 11)}
          cy={H - 12}
          r="1.4"
          style={{ fill: "var(--ink-4)" }}
          opacity="0.35"
        />
      ))}

      {/* 路线（accent 淡色虚线） */}
      <path
        d={path}
        fill="none"
        style={{ stroke: "var(--accent)" }}
        strokeWidth="2.5"
        strokeDasharray="7 6"
        strokeLinecap="round"
        opacity="0.45"
      />

      {/* 站点 */}
      {anchors.map((a, i) => {
        const color = TYPE_COLOR[a.type] ?? "#38bdf8";
        const above = a.y <= cy;
        const labelY = above ? a.y - 34 : a.y + 40;
        const name = a.name.length > 9 ? `${a.name.slice(0, 8)}…` : a.name;
        // 边缘标签钳制：靠边的站名改用 start/end 锚点，防止被 viewBox 裁切
        const nearLeft = a.x < 70;
        const nearRight = a.x > W - 70;
        const labelX = nearLeft ? Math.max(a.x, 30) : nearRight ? Math.min(a.x, W - 30) : a.x;
        const anchor = nearLeft ? "start" : nearRight ? "end" : "middle";
        return (
          <g key={i}>
            <line
              x1={a.x}
              y1={a.y}
              x2={a.x}
              y2={above ? a.y - 14 : a.y + 14}
              stroke={color}
              strokeWidth="1.6"
            />
            <circle
              cx={a.x}
              cy={a.y}
              r="11"
              stroke={color}
              strokeWidth="2.4"
              style={{ fill: "var(--surface-solid)" }}
            />
            <text
              x={a.x}
              y={a.y + 4}
              textAnchor="middle"
              fontSize="12"
              fontWeight="700"
              fill={color}
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
