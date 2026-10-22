"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_PADDING,
  fitView,
  parseLocText,
  projectPixels,
  type MapPoint,
  type MapView,
} from "@/lib/map-view";

// ============================================================
// 真实地图：高德静态地图底图 + 自绘路线/编号标记覆盖层。
//
// 与 RouteMap（假 SVG 正弦曲线示意图）的分工：
// - 验真拿到坐标（PlanSpot.location）的天 → RealMap，站点位置、路线走向是真的；
// - 没坐标（MOCK 模式 / 未验真）的天 → 由 PlanView 传 fallback=RouteMap 降级。
// 绝不把示意图伪装成真实地图——这是本项目的产品红线。
//
// 两个已验证的关键事实（真实 key，2026-10）：
// 1. 高德 `paths` 参数在本项目 key 上恒返回 20003，路线连线只能自绘；
// 2. 静态地图 `size=w*h&scale=2` 返回 2w×2h 的高清 PNG，但地理映射仍按
//    逻辑尺寸 w×h——覆盖层 viewBox 用 w×h 即与底图逐像素对齐。
// ============================================================

/** 每种行程点的语义色，与 RouteMap 的 TYPE_COLOR 保持一致（改色两边一起改） */
const TYPE_COLOR: Record<string, string> = {
  sight: "#38bdf8",
  food: "#fbbf24",
  hotel: "#a78bfa",
  transport: "#94a3b8",
  shopping: "#f472b6",
  activity: "#34d399",
};

const DESIGN_W = 720;
const DESIGN_H = 400;
const MIN_W = 320;
const MAX_W = 720;
const MAX_LABEL_CHARS = 9;
// 与 /api/map 的 loc 上限保持一致：超过就不发请求，直接降级并说明原因
const MAX_STATIONS = 10;

export interface RealMapPoint {
  name: string;
  type: string;
  /** 高德坐标 "经度,纬度"；验真命中时由服务端回填，缺失则该站不上图 */
  location?: string;
}

export interface RealMapProps {
  points: RealMapPoint[];
  /** 地图语义前缀，如「第 1 天」，用于 aria-label（「第 1 天真实路线地图，共 3 站」） */
  label?: string;
  /** 坐标不足 / 底图加载失败时渲染的内容（通常传 RouteMap 做降级） */
  fallback?: ReactNode;
  className?: string;
}

/** 请求尺寸：贴近实际 CSS 宽度，viewBox 单位≈CSS 像素（手机上字不会被缩得看不清） */
function sizeFor(containerWidth: number): { w: number; h: number } {
  const measured =
    Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : DESIGN_W;
  const w = Math.round(Math.max(MIN_W, Math.min(MAX_W, measured)));
  // 保持 720×400 比例，并夹到 /api/map 允许的区间：
  // 两端必须算出一模一样的 w/h，否则服务端按 A 尺寸拟合、客户端按 B 尺寸投影 → 标记漂移
  const h = Math.round(Math.max(200, Math.min(640, (w * DESIGN_H) / DESIGN_W)));
  return { w, h };
}

/** 站名截断：地图上标签是辅助信息，超过 9 字就截（保留可辨识前缀） */
function truncateName(name: string): string {
  const s = (name ?? "").trim();
  return s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1)}…` : s;
}

interface LabelPlacement {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

/**
 * 站名标签摆放：默认在圆点上方（奇数站放下方，减少相邻标签重叠），
 * 贴边时切换 text-anchor / 钳制坐标，保证在 viewBox 内不被裁切。
 */
function placeLabel(
  p: { x: number; y: number },
  index: number,
  w: number,
  h: number,
): LabelPlacement {
  let above = index % 2 === 0;
  if (above && p.y < 30) above = false; // 靠顶边放不下，改下方
  if (!above && p.y > h - 28) above = true; // 靠底边也放不下，改上方
  const y = Math.max(12, Math.min(h - 5, above ? p.y - 20 : p.y + 28));

  // 贴边标签改用 start/end 锚点，避免文字被 viewBox 裁掉（同 RouteMap 的修法）
  const nearLeft = p.x < 80;
  const nearRight = p.x > w - 80;
  const anchor: LabelPlacement["anchor"] = nearLeft ? "start" : nearRight ? "end" : "middle";
  const x = nearLeft
    ? Math.max(2, p.x - 12)
    : nearRight
      ? Math.min(w - 2, p.x + 12)
      : Math.min(w - 30, Math.max(30, p.x));
  return { x, y, anchor };
}

/** 默认降级占位：明确说「没有地图」而不是留一块空白让人以为加载中 */
function DefaultFallback({ text }: { text: string }) {
  return <div className="realmap-fallback">{text}</div>;
}

export function RealMap({ points, label, fallback, className }: RealMapProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // armed = 已进入视口附近，可以真的去请求底图（懒加载的唯一开关）
  const [armed, setArmed] = useState(false);
  const [size, setSize] = useState({ w: DESIGN_W, h: DESIGN_H });
  // ready 只用于内部状态语义；error 会直接渲染 fallback，绝不留破图
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  // 逐站解析坐标，只保留合法的：地图画能定位的站，不因为一站没坐标就整张图作废
  const located = useMemo<Array<{ name: string; type: string; point: MapPoint }>>(
    () =>
      (points ?? []).flatMap((p) => {
        const point = parseLocText(p.location);
        return point ? [{ name: p.name, type: p.type, point }] : [];
      }),
    [points],
  );

  // 懒加载：进入视口附近（rootMargin 200px）才请求。行程页可能同时有 10 天，
  // 一次性全请求会把个人 key 的 QPS 打满，也浪费流量。
  useEffect(() => {
    if (located.length < 2 || located.length > MAX_STATIONS) return;
    const el = wrapRef.current;
    if (!el) return;

    const arm = () => {
      // 量出容器实际宽度再决定请求尺寸；SSR/jsdom 下量不到就用设计宽度
      setSize(sizeFor(el.clientWidth));
      setArmed(true);
      setStatus("loading");
    };

    // 老浏览器/jsdom 没有 IntersectionObserver：直接加载，不能因此白屏
    if (typeof IntersectionObserver === "undefined") {
      arm();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect();
          arm();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [located.length]);

  const view = useMemo<MapView>(
    () =>
      fitView(
        located.map((s) => s.point),
        size.w,
        size.h,
        DEFAULT_PADDING,
      ),
    [located, size.w, size.h],
  );
  const pixels = useMemo(
    () =>
      projectPixels(
        located.map((s) => s.point),
        view,
        size.w,
        size.h,
      ),
    [located, view, size.w, size.h],
  );
  const locText = useMemo(
    () => located.map((s) => `${s.point.lng},${s.point.lat}`).join(";"),
    [located],
  );

  // 站点变化（改行程/换站）后给地图一次重试机会：上一次加载失败可能只是
  // 高德瞬时抖动，不能因为一次失败就让这一天永久停在 fallback 上。
  // 只在已 armed 且处于 error 时复位；locText 不变则不会重试（避免打爆 QPS）。
  useEffect(() => {
    setStatus((prev) => (prev === "error" ? "loading" : prev));
  }, [locText]);

  // 坐标不足 2 个：画不出路线，退回 fallback（不假装有地图）
  if (located.length < 2) {
    return <>{fallback ?? <DefaultFallback text="本日可用坐标不足 2 个，无法绘制真实地图" />}</>;
  }

  // 超过接口上限：不发注定 400 的请求，直接降级并说明原因
  if (located.length > MAX_STATIONS) {
    return (
      <>
        {fallback ?? (
          <DefaultFallback text={`本日可用坐标站点超过 ${MAX_STATIONS} 个，暂无法绘制真实地图`} />
        )}
      </>
    );
  }

  // 底图请求失败（无 key / 高德异常 / 网络断）：降级，绝不留 <img> 破图
  if (status === "error") {
    return (
      <>
        {fallback ?? (
          <DefaultFallback text="真实地图加载失败（高德服务暂不可用），已降级为文字行程" />
        )}
      </>
    );
  }

  const ariaLabel = `${label ?? ""}真实路线地图，共 ${located.length} 站`;

  return (
    <div
      ref={wrapRef}
      className={`realmap${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={ariaLabel}
    >
      {/* SSR/未进入视口：固定宽高比的占位骨架，避免图片加载后页面跳动 */}
      {!armed && (
        <svg
          className="realmap-skeleton"
          viewBox={`0 0 ${DESIGN_W} ${DESIGN_H}`}
          aria-hidden="true"
          focusable="false"
        >
          <rect width={DESIGN_W} height={DESIGN_H} style={{ fill: "var(--surface-solid)" }} />
        </svg>
      )}

      {armed && (
        <>
          <img
            className="realmap-img"
            src={`/api/map?loc=${locText}&w=${size.w}&h=${size.h}&scale=2`}
            width={size.w}
            height={size.h}
            /* 底图是路线的视觉载体：给一个可读 alt（与容器 aria-label 同源），
               读屏用户能知道这里是一张真实路线图而不是装饰图。 */
            alt={ariaLabel}
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
          {/* 覆盖层与底图同尺寸 viewBox；filter 只作用于 img，标记保持原色 */}
          <svg
            className="realmap-overlay"
            viewBox={`0 0 ${size.w} ${size.h}`}
            aria-hidden="true"
            focusable="false"
          >
            {/* 路线：accent 虚线（站点间是直线示意，不是真实道路，别画成实线误导） */}
            <polyline
              className="realmap-route"
              points={pixels.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              strokeWidth="2.5"
              strokeDasharray="7 6"
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity="0.6"
              style={{ stroke: "var(--accent)" }}
            />
            {pixels.map((p, i) => {
              const station = located[i];
              const color = TYPE_COLOR[station.type] ?? TYPE_COLOR.sight;
              const labelPlace = placeLabel(p, i, size.w, size.h);
              return (
                <g key={`${station.name}-${i}`}>
                  <circle
                    className="realmap-stop"
                    cx={p.x}
                    cy={p.y}
                    r="11"
                    stroke={color}
                    strokeWidth="2.4"
                    style={{ fill: "var(--surface-solid)" }}
                  />
                  <text
                    x={p.x}
                    y={p.y + 4}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill={color}
                  >
                    {i + 1}
                  </text>
                  <text
                    className="realmap-label"
                    x={labelPlace.x}
                    y={labelPlace.y}
                    textAnchor={labelPlace.anchor}
                    fontSize="12.5"
                    fontWeight="600"
                    strokeWidth="3"
                    paintOrder="stroke"
                    style={{ fill: "var(--ink)", stroke: "var(--surface-solid)" }}
                  >
                    {truncateName(station.name)}
                  </text>
                </g>
              );
            })}
          </svg>
        </>
      )}
    </div>
  );
}
