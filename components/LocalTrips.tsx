"use client";

import Image from "next/image";
import type { Plan } from "@/lib/types";
import { OfflinePreparation } from "./OfflinePreparation";
import { useMemo, useState, useCallback, type ChangeEvent, type FormEvent } from "react";
import {
  downloadTripCalendar,
  downloadTripFile,
  type LocalMarks,
  type FootprintPosition,
} from "@/lib/trip/trip-file";
import { localDraftKey, readLocalPhoto } from "@/lib/trip/local-trips";
import { tripArrivals } from "@/lib/trip/footprints";
import { useLocalTrips, type OpenLocalTrip } from "./useLocalTrips";
import { isRealDate } from "@/lib/plan/time";
import { findCityPack } from "@/lib/geo/city-packs";
import { TripJournal } from "./TripJournal";
import { useJournalDraft } from "./useJournalDraft";
import { Check, Upload, BookOpen, Footprints } from "lucide-react";
import { TodayView } from "./TodayView";
import { LocalPlanEditor } from "./LocalPlanEditor";
import { LocalTripCheck } from "./LocalTripCheck";

const importPlanView = () => import("./PlanView");

export function LocalTrips() {
  const {
    shelf: trips,
    skipped,
    selected,
    error,
    setError,
    busy,
    select,
    commit,
    startWalk,
    importBackup,
    downloadBackup,
    returnToList,
    remove,
  } = useLocalTrips();
  const {
    draft,
    ready: draftReady,
    status: draftStatus,
    onDraft,
    resetDraft,
  } = useJournalDraft(localDraftKey(selected));
  const [captureOpen, setCaptureOpen] = useState(false);
  const [recentArrival, setRecentArrival] = useState<string>();
  const [removeFile, setRemoveFile] = useState<string>();
  const [undoEdit, setUndoEdit] = useState<OpenLocalTrip>();
  const [activeView, setView] = useState<"today" | "plan" | "journal" | "edit">("today");
  const [FullPlan, setFullPlan] = useState<
    typeof import("./PlanView").PlanView | "loading" | "failed"
  >("loading");
  const arrivedPlaces = useMemo(
    () => (selected ? tripArrivals(selected.plan, selected.marks, selected.arrivals) : {}),
    [selected],
  );
  const view = selected?.walk ? "journal" : activeView;
  const editing = view === "edit";
  const selectedId = selected?.id;
  const readPhoto = useCallback(
    (noteId: string) =>
      selectedId ? readLocalPhoto(selectedId, noteId) : Promise.resolve(undefined),
    [selectedId],
  );

  function goToList() {
    if (busy) return;
    setRecentArrival(undefined);
    setUndoEdit(undefined);
    setRemoveFile(undefined);
    setView("today");
    void returnToList();
  }

  function openJournal(place?: string, capture = false) {
    if (place && !draft.text && !draft.photo) onDraft({ text: "", place });
    setCaptureOpen(capture);
    setView("journal");
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: "instant" });
  }

  async function openFullPlan() {
    setView("plan");
    if (typeof FullPlan === "function") return;
    setFullPlan("loading");
    try {
      const { PlanView } = await importPlanView();
      setFullPlan(() => PlanView);
    } catch {
      setFullPlan("failed");
    }
  }

  async function importFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file && (await importBackup(file))) {
      setUndoEdit(undefined);
      setView("today");
    }
  }

  async function recordMark(id: string, mark?: LocalMarks[string]): Promise<boolean> {
    if (!selected) return false;
    const marks = { ...selected.marks };
    const arrivals = { ...selected.arrivals };
    if (mark) marks[id] = mark;
    else delete marks[id];
    if (mark === "arrived") {
      const spot = selected.plan.days
        .flatMap((day) => day.spots)
        .find((stop) => stop.stopId === id);
      if (!spot) return false;
      arrivals[id] ??= { place: spot.name, at: new Date().toISOString() };
    } else delete arrivals[id];
    if (!(await commit({ ...selected, marks, arrivals }, selected))) return false;
    setRecentArrival(mark === "arrived" ? id : undefined);
    return true;
  }

  function recordStop(place: string, position?: FootprintPosition) {
    if (!selected) return Promise.resolve(false);
    const arrivals = {
      ...selected.arrivals,
      [crypto.randomUUID()]: { place, at: new Date().toISOString(), position },
    };
    return commit({ ...selected, arrivals }, selected);
  }

  async function createTrip(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const city = String(fields.get("city") ?? "").trim();
    const startDate = String(fields.get("date") ?? "");
    if (!city || !isRealDate(startDate)) return;
    const saved = await commit({
      plan: {
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
      },
    });
    if (saved) setView("edit");
  }

  return (
    <main className="container companion-local">
      {!selected && (
        <header className="companion-page-heading">
          <div>
            <h1>本机行程</h1>
            <p>带上计划，沿路记录到达与见闻。</p>
          </div>
          <div className="field-heading-actions">
            <button
              className="btn btn-primary field-start-walk"
              type="button"
              onClick={startWalk}
              disabled={busy}
            >
              <Footprints size={17} aria-hidden="true" /> 开始随走
            </button>
            <label className="companion-local-import field-import">
              <Upload size={16} aria-hidden="true" />
              导入行程文件
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={(event) => void importFile(event)}
              />
            </label>
          </div>
        </header>
      )}
      {!selected && trips.length > 0 && (
        <ul className="companion-trip-list" aria-label="已导入的本机行程">
          {trips.map((trip) => (
            <li className="companion-trip" key={trip.id}>
              <div className="companion-trip-info local-trip-identity">
                <strong>{trip.name}</strong>
                <p>
                  {[trip.date, trip.walk ? trip.lastPlace : `${trip.days} 天`]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={async () => {
                  if (await select(trip.id)) {
                    setUndoEdit(undefined);
                    setView("today");
                  }
                }}
              >
                {trip.walk ? "打开手记" : "打开今日"}
              </button>
              {removeFile === trip.id ? (
                <div className="remove-local-confirm">
                  <span>移除这份行程及其本机记录？</span>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={async () => {
                      await remove(trip);
                      setRemoveFile(undefined);
                    }}
                  >
                    确认移除
                  </button>
                  <button type="button" className="btn" onClick={() => setRemoveFile(undefined)}>
                    取消
                  </button>
                </div>
              ) : (
                <button type="button" className="btn" onClick={() => setRemoveFile(trip.id)}>
                  从本机移除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!selected && trips.length === 0 && (
        <section className="local-walk-invite">
          <Image
            src="/images/asakusa-walk.webp"
            width={300}
            height={200}
            sizes="(max-width: 570px) 96vw, 220px"
            alt=""
          />
          <div>
            <span className="field-label">步行示例 · 2 站</span>
            <h2>东京街头散步</h2>
            <p>从浅草寺走到隅田公园，体验随身行程。</p>
          </div>
          <a className="btn btn-primary" href="/local?open=tokyo">
            打开步行示例
          </a>
        </section>
      )}
      {selected && !selected.id && !error && (
        <p className="field-preview-note">
          {selected.walk
            ? "第一条记录保存后，手记就会留在这台设备上。"
            : "本机示例 · 首次打卡或保存手记时，将建立自己的副本。"}
        </p>
      )}
      {!selected && <OfflinePreparation loadPlan={importPlanView} />}
      {skipped > 0 && !selected && (
        <p className="companion-notice" role="status">
          有 {skipped} 项旧记录未能读取，原始存档仍保存在此浏览器。
        </p>
      )}
      {error && (
        <p className="companion-notice field-error" role="alert">
          {error}
        </p>
      )}
      {!selected && (
        <details className="field-create">
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
      {selected && (
        <>
          <nav className="companion-today-actions" aria-label="本机行程视图">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                goToList();
              }}
            >
              本机列表
            </button>
            {!selected.walk && (
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  aria-pressed={view === "today"}
                  onClick={() => {
                    setView("today");
                  }}
                >
                  今日
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  aria-pressed={view === "plan"}
                  onClick={() => void openFullPlan()}
                >
                  完整行程
                </button>
                <button
                  type="button"
                  className="btn"
                  data-view="journal"
                  disabled={busy}
                  aria-pressed={view === "journal"}
                  onClick={() => openJournal()}
                >
                  <BookOpen size={15} /> 手记
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  aria-pressed={editing}
                  onClick={() => {
                    setView("edit");
                  }}
                >
                  编辑本机计划
                </button>
              </>
            )}
          </nav>
          {editing ? (
            <LocalPlanEditor
              plan={selected.plan}
              busy={busy}
              onSave={async (plan) => {
                const marks = retainTripMarks(plan, selected.marks);
                const saved = await commit(
                  { ...selected, plan, marks, arrivals: arrivedPlaces },
                  selected,
                );
                if (saved) setUndoEdit(selected);
                return saved;
              }}
              onUndo={
                undoEdit
                  ? async () => {
                      // 恢复被移除站点的记录，保留打开「今日」后对其余站点做的改动。
                      const marks = { ...undoEdit.marks, ...selected.marks };
                      // 旅行手记里主动撤销的足迹不随计划撤销复活。
                      for (const [id, action] of Object.entries(marks)) {
                        if (action === "arrived" && !arrivedPlaces[id]) delete marks[id];
                      }
                      for (const day of selected.plan.days) {
                        for (const { stopId } of day.spots) {
                          if (stopId && !selected.marks?.[stopId]) delete marks[stopId];
                        }
                      }
                      if (
                        await commit(
                          {
                            ...selected,
                            plan: undoEdit.plan,
                            marks: retainTripMarks(undoEdit.plan, marks),
                          },
                          selected,
                        )
                      ) {
                        setUndoEdit(undefined);
                      }
                    }
                  : undefined
              }
            />
          ) : view === "journal" ? (
            <TripJournal
              plan={selected.plan}
              arrivals={arrivedPlaces}
              onForgetArrival={(id) => recordMark(id)}
              onRecordArrival={recordStop}
              walk={selected.walk}
              title={selected.title}
              onRename={
                selected.walk && !!selected.id
                  ? (title) => commit({ ...selected, title }, selected)
                  : undefined
              }
              captureOpen={captureOpen}
              draft={draft}
              onDraft={onDraft}
              draftStatus={draftStatus}
              notes={selected.notes ?? []}
              onSave={(notes) => commit({ ...selected, notes }, selected, draft)}
              onSaved={resetDraft}
              loadPhoto={readPhoto}
              busy={busy || !draftReady}
            />
          ) : view === "today" ? (
            <TodayView
              plan={selected.plan}
              onJournal={openJournal}
              onExtraStop={() => openJournal(undefined, true)}
              localMarks={selected.marks ?? {}}
              onLocalMark={recordMark}
              localSaving={busy}
              arrivalReceipt={
                recentArrival &&
                selected.arrivals?.[recentArrival] && (
                  <div className="arrival-receipt">
                    <p role="status">
                      <Check size={16} aria-hidden="true" /> 已记录到达 ·{" "}
                      {selected.arrivals[recentArrival].place}
                    </p>
                    <button
                      className="btn"
                      type="button"
                      onClick={() => openJournal(selected.arrivals?.[recentArrival]?.place)}
                    >
                      {draft.text || draft.photo ? "继续未写完的手记" : "记下刚才这一站"}
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => void recordMark(recentArrival)}
                    >
                      撤销这次打卡
                    </button>
                  </div>
                )
              }
            />
          ) : FullPlan === "loading" ? (
            <p role="status">正在打开完整行程…</p>
          ) : FullPlan === "failed" ? (
            <p role="alert">无法打开完整行程。请联网后重试，或切回「今日」查看安排。</p>
          ) : (
            <FullPlan plan={selected.plan} importedFile />
          )}
          {view !== "journal" && !editing && <LocalTripCheck plan={selected.plan} />}
          <div className="companion-today-actions">
            <OfflinePreparation loadPlan={selected.walk ? undefined : importPlanView} />
            {!selected.walk && (
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
            )}
            {!selected.walk && selected.plan.startDate && (
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
            {(Object.keys(selected.marks ?? {}).length > 0 ||
              Object.keys(selected.arrivals ?? {}).length > 0 ||
              !!selected.notes?.length) && (
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void downloadBackup()}
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
