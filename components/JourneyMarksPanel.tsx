"use client";

import { useRef, useState } from "react";
import type { JourneyAction, JourneyCommand, JourneyMark } from "@/lib/trip/journey-marks";
import { downloadTripFile } from "@/lib/trip/trip-file";
import type { Plan, PlanSpot } from "@/lib/types";

type JourneySnapshot = { revision: number; marks: JourneyMark[] };

export function JourneyMarksPanel({
  shareId,
  spots,
  plan,
}: {
  shareId: string;
  spots: PlanSpot[];
  plan?: Plan;
}) {
  const endpoint = `/api/journey/${encodeURIComponent(shareId)}`;
  const [journey, setJourney] = useState<JourneySnapshot>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef<JourneyCommand | null>(null);

  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) {
        setJourney(undefined);
        setError(
          response.status === 401 ? "请先登录，再记录旅行进展。" : "无法打开这趟旅行的私人记录。",
        );
        return;
      }
      setJourney((await response.json()) as JourneySnapshot);
      retry.current = null;
    } catch {
      setError("网络异常，暂时无法读取记录。");
    } finally {
      setBusy(false);
    }
  }

  async function mark(stopId: string, action: JourneyAction) {
    if (!journey || busy) return;
    const previous = retry.current;
    if (previous && (previous.stopId !== stopId || previous.action !== action)) {
      setError("请先重试上一条记录，或刷新后确认它是否保存。");
      return;
    }
    const command = previous ?? {
      stopId,
      action,
      commandId: crypto.randomUUID(),
      planRevision: journey.revision,
    };
    retry.current = command;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        if (response.status < 500) retry.current = null;
        if (response.status === 401 || response.status === 404) setJourney(undefined);
        setError((await response.json()).error ?? "记录未保存，请稍后重试。");
        return;
      }
      const { mark: saved } = (await response.json()) as { mark: JourneyMark };
      setJourney({ ...journey, marks: [...journey.marks, saved] });
      retry.current = null;
    } catch {
      setError("没收到保存确认，请用同一个按钮重试。");
    } finally {
      setBusy(false);
    }
  }

  const eligible = spots.flatMap((spot) => (spot.stopId ? [{ ...spot, stopId: spot.stopId }] : []));
  if (eligible.length === 0) return null;

  return (
    <section className="card at-journey-marks">
      <div className="card-body">
        <button type="button" className="btn" disabled={busy} onClick={() => void load()}>
          {journey ? "刷新私人记录" : "记录今天的进展"}
        </button>
        {plan && journey && journey.marks.length > 0 && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              try {
                downloadTripFile(
                  plan,
                  Object.fromEntries(journey.marks.map(({ stopId, action }) => [stopId, action])),
                );
              } catch {
                setError("无法下载这份备份。");
              }
            }}
          >
            下载含进展的备份
          </button>
        )}
        {error && <p role="alert">{error}</p>}
        {journey && (
          <ul className="today-spots" aria-label="今日私人记录">
            {eligible.map((spot) => {
              const saved = journey.marks.find((record) => record.stopId === spot.stopId);
              return (
                <li className="today-spot" key={spot.stopId}>
                  <strong>{spot.name}</strong>
                  {saved ? (
                    <p>{saved.action === "arrived" ? "已到达" : "已跳过"}</p>
                  ) : (
                    <div className="today-spot-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        aria-label={`到达${spot.name}`}
                        onClick={() => void mark(spot.stopId, "arrived")}
                      >
                        我到了
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        aria-label={`跳过${spot.name}`}
                        onClick={() => void mark(spot.stopId, "skipped")}
                      >
                        跳过
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
