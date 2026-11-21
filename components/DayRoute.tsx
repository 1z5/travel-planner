"use client";

import { useMemo, useState } from "react";
import { ArrowDown, MapPin, Route } from "lucide-react";
import { fmtDist } from "@/lib/geo/spatial";
import { layoutRoutePoints, parseLocText, ROUTE_HEIGHT, ROUTE_WIDTH } from "@/lib/geo/map-view";
import type { PlanSpot } from "@/lib/types";
import type { LocalMarks } from "@/lib/trip/trip-file";

export function DayRoute({
  spots,
  current,
  marks,
  day,
  children,
  distanceFor,
  onJournal,
}: {
  spots: PlanSpot[];
  current?: number;
  marks?: LocalMarks;
  day: number;
  children?: React.ReactNode;
  onJournal?: (place: string) => void;
  distanceFor: (location?: string) => number | null;
}) {
  const [choice, setChoice] = useState<number>();
  const index = choice !== undefined && spots[choice] ? choice : (current ?? 0);
  const spot = spots[index];
  const pins = useMemo(() => {
    const points = spots.flatMap((stop, index) => {
      const point = parseLocText(stop.location);
      return point ? [{ ...point, index }] : [];
    });
    return layoutRoutePoints(points).map(({ location, x, y }) => ({ x, y, index: location.index }));
  }, [spots]);
  if (!spot) return null;
  const meters = distanceFor(spot.location);
  const marked = spot.stopId ? marks?.[spot.stopId] : undefined;
  return (
    <section className="day-route" aria-label="今日路线索引">
      <div className="route-panel-head">
        <h2>
          <Route size={17} aria-hidden="true" /> 今日路线
        </h2>
        <span>{spots.length} 站</span>
      </div>
      {pins.length > 0 ? (
        <>
          <div className="route-geography">
            <span className="route-north" aria-label="上方为北">
              ↑ N
            </span>
            <svg viewBox={`0 0 ${ROUTE_WIDTH} ${ROUTE_HEIGHT}`} aria-hidden="true">
              {pins
                .slice(1)
                .map(
                  (p, i) =>
                    p.index === pins[i]!.index + 1 && (
                      <line key={p.index} x1={pins[i]!.x} y1={pins[i]!.y} x2={p.x} y2={p.y} />
                    ),
                )}
            </svg>
            {pins.map((p) => (
              <button
                type="button"
                key={p.index}
                className="route-pin"
                style={{
                  left: `${(p.x / ROUTE_WIDTH) * 100}%`,
                  top: `${(p.y / ROUTE_HEIGHT) * 100}%`,
                }}
                aria-label={`查看第 ${p.index + 1} 站 ${spots[p.index]!.name}`}
                aria-pressed={index === p.index}
                onClick={() => setChoice(p.index)}
              >
                <span>{p.index + 1}</span>
              </button>
            ))}
          </div>
          <p className="route-caption">
            站点方位示意 · {pins.length}/{spots.length} 站有坐标
          </p>
        </>
      ) : (
        <div className="route-sequence" aria-label="按计划顺序选站">
          {spots.map((s, i) => (
            <button
              key={s.stopId ?? i}
              type="button"
              aria-pressed={i === index}
              onClick={() => setChoice(i)}
            >
              <b>{String(i + 1).padStart(2, "0")}</b>
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="route-inspect">
        <label>
          <MapPin size={16} aria-hidden="true" />
          <select
            aria-label="查看路线站点"
            value={index}
            onChange={(e) => setChoice(Number(e.target.value))}
          >
            {spots.map((s, i) => (
              <option key={i} value={i}>
                {i + 1}. {s.name}
              </option>
            ))}
          </select>
        </label>
        <p>
          {[
            index !== current ? spot.area : "",
            index !== current ? spot.time : "",
            meters === null ? "" : `距定位点约 ${fmtDist(meters)}（直线）`,
            marked === "arrived" ? "已记录到达" : marked === "skipped" ? "已记录跳过" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {spot.reason && <p className="route-reason">{spot.reason}</p>}
        {children}
        {onJournal && (
          <button type="button" className="btn" onClick={() => onJournal(spot.name)}>
            在本站写手记
          </button>
        )}
        <a href={`#day-${day}-stop-${index + 1}`}>
          <ArrowDown size={14} aria-hidden="true" /> 查看本站安排
        </a>
      </div>
    </section>
  );
}
