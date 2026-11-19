"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { Plan } from "@/lib/types";
import {
  downloadTripFile,
  readTripBackup,
  serializeTripFile,
  TRIP_FILE_MAX_BYTES,
  type LocalMarks,
} from "@/lib/trip/trip-file";
import {
  assignLocalStopIds,
  listLocalTrips,
  removeLocalTrip,
  saveLocalTrip,
} from "@/lib/trip/local-trips";
import { addDays, isRealDate } from "@/lib/plan/time";
import { PlanView } from "./PlanView";
import { TodayView } from "./TodayView";

type LocalTrip = ReturnType<typeof readTripBackup> & { file: string };

function readSavedTrips(): LocalTrip[] {
  return listLocalTrips().map((file) => ({ file, ...readTripBackup(file) }));
}

export function LocalTrips() {
  const [trips, setTrips] = useState<LocalTrip[]>([]);
  const [selected, setSelected] = useState<LocalTrip>();
  const [showToday, setShowToday] = useState(true);
  const [error, setError] = useState("");
  const [offlineReady, setOfflineReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        setTrips(readSavedTrips());
      } catch {
        setError("无法读取本机行程。你仍可以打开已下载的文件。");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  async function prepareOffline() {
    if (!navigator.serviceWorker) {
      setError("当前浏览器无法准备离线页面。请下载 PDF 作为离线备份。");
      return;
    }
    setError("");
    const worker = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    if (!worker?.active) {
      setError("离线功能还未就绪。请联网刷新后重试。");
      return;
    }
    const assets = performance
      .getEntriesByType("resource")
      .map(({ name }) => new URL(name, location.origin))
      .filter((url) => url.origin === location.origin && url.pathname.startsWith("/_next/static/"))
      .map((url) => url.pathname);
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      setError("未能准备离线页面，请联网重试。");
    }, 15000);
    channel.port1.addEventListener(
      "message",
      ({ data }) => {
        clearTimeout(timeout);
        channel.port1.close();
        setOfflineReady(data === true);
        if (data !== true) setError("未能准备离线页面，请联网重试。");
      },
      { once: true },
    );
    channel.port1.start();
    worker.active.postMessage({ type: "prepare-local", assets }, [channel.port2]);
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > TRIP_FILE_MAX_BYTES) {
      setError("行程文件不能超过 2 MB。");
      return;
    }
    setError("");
    setImporting(true);
    try {
      const { plan, marks } = readTripBackup(await file.text());
      const backup = serializeTripFile(plan, marks);
      const existing = trips.find((trip) => trip.file === backup);
      if (existing) {
        setSelected(existing);
        setShowToday(true);
      } else {
        openTrip(assignLocalStopIds(plan), marks);
      }
    } catch {
      setError("无法读取这个文件。请选择 AI Travel Companion 下载的行程 JSON。");
    } finally {
      setImporting(false);
    }
  }

  function openTrip(plan: Plan, marks?: LocalMarks, previous?: string) {
    let file: string;
    try {
      file = serializeTripFile(plan, marks);
    } catch {
      setError("无法保存此行程，可能已超过行程文件的大小限制。");
      return;
    }
    setSelected({ plan, marks, file });
    if (!previous) {
      setShowToday(true);
      setEditing(false);
    }
    try {
      saveLocalTrip(plan, previous, marks);
      setTrips(readSavedTrips());
      setError("");
    } catch {
      setError("行程已打开，但无法保存到本机列表。请保留原文件。");
    }
  }

  function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const city = String(fields.get("city") ?? "").trim();
    const startDate = String(fields.get("date") ?? "");
    if (!city || !isRealDate(startDate)) return;
    openTrip({
      city,
      startDate,
      endDate: startDate,
      summary: "",
      days: [
        {
          day: 1,
          theme: "第 1 天",
          spots: [],
          dailyCostCny: 0,
          transitMin: 0,
          transitKnown: false,
        },
      ],
      totalCostCny: 0,
      tips: [],
      warnings: [],
      verified: false,
    });
    setEditing(true);
  }

  function removeTrip(trip: LocalTrip) {
    try {
      removeLocalTrip(trip.file);
      setTrips(readSavedTrips());
      if (selected?.file === trip.file) setSelected(undefined);
      setError("");
    } catch {
      setError("无法从本机移除行程，请重试。");
    }
  }

  return (
    <main className="container companion-local">
      <header className="companion-page-heading">
        <div>
          <h1>本机行程</h1>
          <p>导入行程文件，在这台设备上查看计划和今日安排。</p>
        </div>
        <label className="companion-local-import">
          导入行程文件
          <input
            type="file"
            accept=".json,application/json"
            disabled={importing}
            onChange={(event) => void importFile(event)}
          />
        </label>
      </header>
      <button type="button" className="btn" onClick={() => void prepareOffline()}>
        准备离线打开
      </button>
      {offlineReady && (
        <p className="helper" role="status">
          可以离线重新打开本机行程页。请保留下载的文件作为备份。
        </p>
      )}
      {error && (
        <p className="companion-notice" role="alert">
          {error}
        </p>
      )}
      {!selected && (
        <details>
          <summary>手动新建行程</summary>
          <form className="companion-local-form" onSubmit={createTrip}>
            <label>
              目的地
              <input name="city" required maxLength={80} />
            </label>
            <label>
              出发日期
              <input name="date" type="date" required />
            </label>
            <button className="btn btn-primary">创建本机行程</button>
          </form>
        </details>
      )}
      {!selected && trips.length > 0 && (
        <ul className="companion-trip-list" aria-label="已导入的本机行程">
          {trips.map((trip) => (
            <li className="companion-trip" key={trip.file}>
              <span>
                {trip.plan.city} · {trip.plan.days.length} 天
                {trip.plan.startDate && ` · ${trip.plan.startDate}`}
              </span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (trip.plan.days.some((day) => day.spots.some((spot) => !spot.stopId))) {
                    openTrip(assignLocalStopIds(trip.plan), trip.marks, trip.file);
                  } else {
                    setSelected(trip);
                  }
                  setShowToday(true);
                  setEditing(false);
                }}
              >
                打开今日
              </button>
              <button type="button" className="btn" onClick={() => removeTrip(trip)}>
                从本机移除
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <>
          <nav className="companion-today-actions" aria-label="本机行程视图">
            <button type="button" className="btn" onClick={() => setSelected(undefined)}>
              本机列表
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={showToday}
              onClick={() => {
                setShowToday(true);
                setEditing(false);
              }}
            >
              今日
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={!showToday}
              onClick={() => {
                setShowToday(false);
                setEditing(false);
              }}
            >
              完整行程
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={editing}
              onClick={() => {
                if (selected.plan.days.some((day) => day.spots.some((spot) => !spot.stopId))) {
                  openTrip(assignLocalStopIds(selected.plan), selected.marks, selected.file);
                }
                setEditing(true);
              }}
            >
              编辑本机计划
            </button>
            {selected.marks && Object.keys(selected.marks).length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  try {
                    downloadTripFile(selected.plan, selected.marks);
                  } catch {
                    setError("无法下载这份备份。");
                  }
                }}
              >
                下载含进展的备份
              </button>
            )}
          </nav>
          <p className="helper">行程和进展保存在本机。打印 PDF 或下载文件可留作备份。</p>
          {editing ? (
            <LocalPlanEditor
              plan={selected.plan}
              onSave={(plan) => openTrip(plan, selected.marks, selected.file)}
            />
          ) : showToday ? (
            <TodayView
              plan={selected.plan}
              localMarks={selected.marks ?? {}}
              onLocalMark={(id, mark) => {
                const marks = { ...selected.marks };
                if (mark) marks[id] = mark;
                else delete marks[id];
                openTrip(selected.plan, marks, selected.file);
              }}
            />
          ) : (
            <PlanView plan={selected.plan} importedFile />
          )}
        </>
      )}
    </main>
  );
}

function LocalPlanEditor({ plan, onSave }: { plan: Plan; onSave: (plan: Plan) => void }) {
  function updateDay(index: number, spots: Plan["days"][number]["spots"]) {
    onSave({
      ...plan,
      days: plan.days.map((day, i) =>
        i === index
          ? {
              ...day,
              spots,
              legs: undefined,
              transitMin: 0,
              transitKnown: false,
            }
          : day,
      ),
    });
  }

  return (
    <section className="companion-local-form" aria-label="编辑本机计划">
      {plan.days.map((day, index) => (
        <section className="card card-body" key={index}>
          <h2>第 {index + 1} 天</h2>
          <ol>
            {day.spots.map((spot, i) => (
              <li key={spot.stopId ?? i}>
                {spot.time} {spot.name}{" "}
                <button
                  className="btn"
                  type="button"
                  disabled={i === 0}
                  onClick={() => {
                    const spots = [...day.spots];
                    [spots[i - 1], spots[i]] = [spots[i]!, spots[i - 1]!];
                    updateDay(index, spots);
                  }}
                >
                  上移
                </button>
              </li>
            ))}
          </ol>
          <form
            className="companion-local-form"
            onSubmit={(event) => {
              event.preventDefault();
              const fields = new FormData(event.currentTarget);
              const name = String(fields.get("name") ?? "").trim();
              const start = String(fields.get("start") ?? "");
              const end = String(fields.get("end") ?? "");
              if (!name || end <= start) return;
              updateDay(index, [
                ...day.spots,
                {
                  stopId: crypto.randomUUID(),
                  name,
                  time: `${start}-${end}`,
                  area: "",
                  period: "morning",
                  type: "sight",
                  reason: "",
                  costCny: 0,
                  durationMin:
                    (Number(end.slice(0, 2)) - Number(start.slice(0, 2))) * 60 +
                    Number(end.slice(3)) -
                    Number(start.slice(3)),
                },
              ]);
              event.currentTarget.reset();
            }}
          >
            <label>
              站点名称
              <input name="name" required maxLength={120} />
            </label>
            <label>
              开始时间
              <input name="start" type="time" required />
            </label>
            <label>
              结束时间
              <input name="end" type="time" required />
            </label>
            <button className="btn" disabled={day.spots.length >= 100}>
              添加站点
            </button>
          </form>
        </section>
      ))}
      <button
        type="button"
        className="btn"
        disabled={plan.days.length >= 30}
        onClick={() => {
          const day = plan.days.length + 1;
          onSave({
            ...plan,
            endDate: plan.startDate ? addDays(plan.startDate, day - 1) : undefined,
            days: [
              ...plan.days,
              {
                day,
                theme: `第 ${day} 天`,
                spots: [],
                dailyCostCny: 0,
                transitMin: 0,
                transitKnown: false,
              },
            ],
          });
        }}
      >
        添加一天
      </button>
    </section>
  );
}
