"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import type { Plan, PlanSpot } from "@/lib/types";
import {
  downloadTripFile,
  downloadTripCalendar,
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
import { addDays, isRealDate, parseTimeRange } from "@/lib/plan/time";
import { findCityPack, type CityPack } from "@/lib/geo/city-packs";
import { tokyoLocalTrip } from "../demo/fixtures/tokyo-local";
import { TodayView } from "./TodayView";
import { LocalTripCheck } from "./LocalTripCheck";

const importPlanView = () => import("./PlanView");

type LocalTrip = ReturnType<typeof readTripBackup> & { file: string };

function readSavedTrips(): LocalTrip[] {
  return listLocalTrips().map((file) => ({ file, ...readTripBackup(file) }));
}

export function LocalTrips() {
  const [trips, setTrips] = useState<LocalTrip[]>([]);
  const [selected, setSelected] = useState<LocalTrip>();
  const [undoEdit, setUndoEdit] = useState<LocalTrip>();
  const [showToday, setShowToday] = useState(true);
  const [FullPlan, setFullPlan] = useState<
    typeof import("./PlanView").PlanView | "loading" | "failed"
  >("loading");
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

  async function openFullPlan() {
    setShowToday(false);
    setEditing(false);
    if (typeof FullPlan === "function") return;
    setFullPlan("loading");
    try {
      const { PlanView } = await importPlanView();
      setFullPlan(() => PlanView);
    } catch {
      setFullPlan("failed");
    }
  }

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
    try {
      // 完整行程按需加载。准备离线时先下载其代码，让资源记录也包含对应的分包。
      await importPlanView();
    } catch {
      setError("未能下载完整行程视图，请联网重试。");
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
        setUndoEdit(undefined);
        setEditing(false);
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
      return false;
    }
    try {
      saveLocalTrip(plan, previous, marks);
      setTrips(readSavedTrips());
      setError("");
    } catch {
      if (previous) {
        setError("当前改动未能保存到本机。请重试。");
        return false;
      }
      setError("行程已打开，但未保存到本机列表。请下载行程文件留存。");
    }
    setSelected({ plan, marks, file });
    if (!previous) {
      setUndoEdit(undefined);
      setShowToday(true);
      setEditing(false);
    }
    return true;
  }

  function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const city = String(fields.get("city") ?? "").trim();
    const startDate = String(fields.get("date") ?? "");
    if (!city || !isRealDate(startDate)) return;
    openTrip({
      city,
      timeZone: findCityPack(city)?.timeZone,
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
      {!selected && (
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
      )}
      <button type="button" className="btn" onClick={() => void prepareOffline()}>
        准备离线打开
      </button>
      {!selected && (
        <button
          type="button"
          className="btn companion-local-sample"
          onClick={() => {
            try {
              downloadTripFile(tokyoLocalTrip());
              setError("");
            } catch {
              setError("无法下载东京示例。");
            }
          }}
        >
          下载东京示例
        </button>
      )}
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
                  setUndoEdit(undefined);
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
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSelected(undefined);
                setUndoEdit(undefined);
              }}
            >
              本机列表
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={showToday && !editing}
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
              aria-pressed={!showToday && !editing}
              onClick={() => void openFullPlan()}
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
          </nav>
          {editing ? (
            <LocalPlanEditor
              plan={selected.plan}
              onSave={(plan) => {
                const marks = retainTripMarks(plan, selected.marks);
                if (openTrip(plan, marks, selected.file)) setUndoEdit(selected);
              }}
              onUndo={
                undoEdit
                  ? () => {
                      // 恢复被移除站点的记录，保留打开「今日」后对其余站点做的改动。
                      const marks = { ...undoEdit.marks, ...selected.marks };
                      for (const day of selected.plan.days) {
                        for (const { stopId } of day.spots) {
                          if (stopId && !selected.marks?.[stopId]) delete marks[stopId];
                        }
                      }
                      if (
                        openTrip(
                          undoEdit.plan,
                          retainTripMarks(undoEdit.plan, marks),
                          selected.file,
                        )
                      ) {
                        setUndoEdit(undefined);
                      }
                    }
                  : undefined
              }
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
          ) : FullPlan === "loading" ? (
            <p role="status">正在打开完整行程…</p>
          ) : FullPlan === "failed" ? (
            <p role="alert">无法打开完整行程。请联网后重试，或切回「今日」查看安排。</p>
          ) : (
            <FullPlan plan={selected.plan} importedFile />
          )}
          {!editing && <LocalTripCheck plan={selected.plan} />}
          <div className="companion-today-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                try {
                  downloadTripFile(selected.plan);
                  setError("");
                } catch {
                  setError("无法下载这份行程。");
                }
              }}
            >
              下载行程文件
            </button>
            {selected.plan.startDate && (
              <button
                type="button"
                className="btn companion-local-calendar"
                onClick={() => {
                  try {
                    downloadTripCalendar(selected.plan);
                    setError("");
                  } catch {
                    setError("无法下载日历。");
                  }
                }}
              >
                下载日历（.ics）
              </button>
            )}
            {selected.marks && Object.keys(selected.marks).length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  try {
                    downloadTripFile(selected.plan, selected.marks);
                    setError("");
                  } catch {
                    setError("无法下载这份备份。");
                  }
                }}
              >
                下载含进展的备份
              </button>
            )}
          </div>
        </>
      )}
    </main>
  );
}

function retainTripMarks(plan: Plan, marks: LocalMarks | undefined): LocalMarks | undefined {
  if (!marks) return;
  const ids = new Set(plan.days.flatMap((day) => day.spots.map((spot) => spot.stopId)));
  return Object.fromEntries(Object.entries(marks).filter(([id]) => ids.has(id)));
}

function LocalPlanEditor({
  plan,
  onSave,
  onUndo,
}: {
  plan: Plan;
  onSave: (plan: Plan) => void;
  onUndo?: () => void;
}) {
  const cityPack = plan.cities?.length ? undefined : findCityPack(plan.city);

  function updateDay(index: number, spots: Plan["days"][number]["spots"]) {
    const dailyCostCny = spots.reduce((total, spot) => total + spot.costCny, 0);
    onSave({
      ...plan,
      totalCostCny: plan.days.reduce(
        (total, day, i) => total + (i === index ? dailyCostCny : day.dailyCostCny),
        0,
      ),
      days: plan.days.map((day, i) =>
        i === index
          ? {
              ...day,
              spots,
              dailyCostCny,
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
      <h1>{plan.city} · 编辑计划</h1>
      {onUndo && (
        <button type="button" className="btn" onClick={onUndo}>
          撤销上次编辑
        </button>
      )}
      {plan.days.map((day, index) => (
        <section className="card card-body" key={index}>
          <h2>第 {index + 1} 天</h2>
          <ol className="companion-local-stops">
            {day.spots.map((spot, i) => (
              <li key={spot.stopId ?? i}>
                <span className="companion-local-stop-time">{spot.time}</span>
                <strong>{spot.name}</strong>
                <div className="companion-local-stop-actions">
                  <button
                    className="btn"
                    type="button"
                    aria-label={`上移${spot.name}`}
                    disabled={i === 0}
                    onClick={() => {
                      const spots = [...day.spots];
                      [spots[i - 1], spots[i]] = [spots[i]!, spots[i - 1]!];
                      updateDay(index, spots);
                    }}
                  >
                    上移
                  </button>
                  <button
                    className="btn"
                    type="button"
                    aria-label={`移除${spot.name}`}
                    onClick={() =>
                      updateDay(
                        index,
                        day.spots.filter((_, j) => j !== i),
                      )
                    }
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <LocalStopForm
            cityPack={cityPack}
            disabled={day.spots.length >= 100}
            onAdd={(spot) => updateDay(index, [...day.spots, spot])}
          />
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

function LocalStopForm({
  cityPack,
  disabled,
  onAdd,
}: {
  cityPack?: CityPack;
  disabled: boolean;
  onAdd: (spot: PlanSpot) => void;
}) {
  const [placeId, setPlaceId] = useState("");
  const place = cityPack?.places.find(({ id }) => id === placeId);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const name = place?.name ?? String(fields.get("name") ?? "").trim();
    const time = `${fields.get("start")}-${fields.get("end")}`;
    const range = parseTimeRange(time);
    if (disabled || !name || !range || range.end <= range.start) return;
    onAdd({
      stopId: crypto.randomUUID(),
      name,
      time,
      area: place?.area ?? "",
      navigationQuery: place?.navigationQuery,
      placeSource: place?.placeSource,
      openingHoursNote: place?.openingHoursNote,
      period: "morning",
      type: "sight",
      reason: "",
      costCny: 0,
      durationMin: range.end - range.start,
    });
    event.currentTarget.reset();
    setPlaceId("");
  }

  return (
    <form className="companion-local-form" onSubmit={submit}>
      {cityPack && (
        <label>
          从{cityPack.city}城市包添加
          <select value={placeId} onChange={(event) => setPlaceId(event.target.value)}>
            <option value="">手动填写</option>
            {cityPack.places.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {!place && (
        <label>
          站点名称
          <input name="name" required maxLength={120} />
        </label>
      )}
      <label>
        开始时间
        <input name="start" type="time" required />
      </label>
      <label>
        结束时间
        <input name="end" type="time" required />
      </label>
      <button className="btn" disabled={disabled}>
        添加站点
      </button>
    </form>
  );
}
