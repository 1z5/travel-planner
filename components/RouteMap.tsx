"use client";

import { Landmark, Utensils, BedDouble, TrainFront, ShoppingBag, Compass } from "lucide-react";

const TYPE_ICON: Record<string, typeof Landmark> = {
  sight: Landmark, food: Utensils, hotel: BedDouble, transport: TrainFront,
  shopping: ShoppingBag, activity: Compass,
};

const TYPE_COLOR: Record<string, string> = {
  sight: "#0ea5e9", food: "#f59e0b", hotel: "#8b5cf6", transport: "#64748b",
  shopping: "#ec4899", activity: "#10b981",
};

export interface RouteStop {
  name: string;
  type: string;
}

/**
 * 每日路线示意图：把当天的行程点画成一条编号路线。
 * 注意这是示意图（非地理精确）——地理坐标版在接入高德 key 后升级。
 */
export function RouteMap({ stops }: { stops: RouteStop[] }) {
  if (stops.length === 0) return null;

  const W = 720;
  const H = 132;
  const padX = 56;
  const n = stops.length;

  // 锚点：横向均匀分布，纵向正弦起伏（避免连线呆板）
  const anchors = stops.map((s, i) => ({
    ...s,
    x: n === 1 ? W / 2 : padX + (i * (W - padX * 2)) / (n - 1),
    y: H / 2 + Math.sin(i * 1.35) * 30,
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
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}
         role="img" aria-label="当日路线示意图">
      <defs>
        <linearGradient id="rm-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0f7ff" />
          <stop offset="100%" stopColor="#e8f4fd" />
        </linearGradient>
      </defs>
      <rect width={W} height={H} fill="url(#rm-bg)" rx="10" />

      {/* 装饰网格点 */}
      {Array.from({ length: 12 }).map((_, i) => (
        <circle key={i} cx={40 + i * 58} cy={H - 12} r="1.4" fill="#c7d9ec" />
      ))}

      {/* 路线 */}
      <path d={path} fill="none" stroke="#93b8e8" strokeWidth="2.5"
            strokeDasharray="7 6" strokeLinecap="round" />

      {/* 站点 */}
      {anchors.map((a, i) => {
        const color = TYPE_COLOR[a.type] ?? "#2563eb";
        const above = a.y <= H / 2;
        const labelY = above ? a.y - 34 : a.y + 44;
        const name = a.name.length > 9 ? `${a.name.slice(0, 8)}…` : a.name;
        // 边缘标签钳制：靠边的站名改用 start/end 锚点，防止被 viewBox 裁切
        const nearLeft = a.x < 70;
        const nearRight = a.x > W - 70;
        const labelX = nearLeft ? Math.max(a.x, 30) : nearRight ? Math.min(a.x, W - 30) : a.x;
        const anchor = nearLeft ? "start" : nearRight ? "end" : "middle";
        return (
          <g key={i}>
            <line x1={a.x} y1={a.y} x2={a.x} y2={above ? a.y - 14 : a.y + 14}
                  stroke={color} strokeWidth="1.6" />
            <circle cx={a.x} cy={a.y} r="11" fill="#fff" stroke={color} strokeWidth="2.4" />
            <text x={a.x} y={a.y + 4} textAnchor="middle" fontSize="11"
                  fontWeight="700" fill={color}>{i + 1}</text>
            <text x={labelX} y={labelY} textAnchor={anchor} fontSize="11.5"
                  fill="#3b5266">{name}</text>
          </g>
        );
      })}
    </svg>
  );
}
