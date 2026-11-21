"use client";

import { useEffect, useRef, useState } from "react";
import { tokyoLocalTrip } from "../demo/fixtures/tokyo-local";
import { walkPlan } from "@/lib/trip/footprints";
import { localTripHref } from "@/lib/trip/local-library";
import {
  assignLocalStopIds,
  localDraftKey,
  LocalTripConflict,
  readLocalTrip,
  readSavedTrips,
  removeLocalTrip,
  restoreLocalTrip,
  saveLocalTrip,
  type JournalDraft,
  type LocalTrip,
  type LocalTripContent,
  type LocalTripSummary,
} from "@/lib/trip/local-trips";
import { downloadTripFile, readTripBackup, TRIP_BACKUP_MAX_BYTES } from "@/lib/trip/trip-file";

export type OpenLocalTrip = LocalTripContent & Partial<Pick<LocalTrip, "id" | "revision">>;

function showAddress(id?: string) {
  const href = id ? localTripHref(id) : "/local";
  if (window.location.pathname + window.location.search !== href)
    window.history.replaceState(window.history.state, "", href);
}

export function useLocalTrips() {
  const [shelf, setShelf] = useState<LocalTripSummary[]>([]);
  const [selected, setSelected] = useState<OpenLocalTrip>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState(0);
  const pending = useRef(false);
  const navigation = useRef(0);

  useEffect(() => {
    let active = true;
    const initial = navigation.current;
    const params = new URLSearchParams(window.location.search);
    const id = params.get("trip");
    const entry = params.get("open");
    if (!id && entry === "tokyo") setSelected({ plan: assignLocalStopIds(tokyoLocalTrip()) });
    else if (!id && entry === "walk") setSelected({ plan: walkPlan(), walk: true });

    async function load() {
      try {
        const { trips, skipped } = await readSavedTrips();
        if (!active || navigation.current !== initial) return;
        setShelf(trips);
        setSkipped(skipped);
        const open = id ?? (entry === "recent" ? trips[0]?.id : undefined);
        if (open == null) return;

        const trip = open && (await readLocalTrip(open));
        if (!active || navigation.current !== initial) return;
        if (!trip) {
          setError("这份行程在当前浏览器中找不到。你可以打开其他本机行程，或导入备份。");
          return;
        }
        setSelected(trip);
        showAddress(trip.id);
      } catch {
        if (active && navigation.current === initial)
          setError("无法读取本机行程库。你仍可以打开已下载的文件。");
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, []);

  async function run<T>(task: () => Promise<T>, message: string): Promise<T | undefined> {
    if (pending.current) return;
    pending.current = true;
    navigation.current++;
    setBusy(true);
    setError("");
    try {
      return await task();
    } catch (cause) {
      setError(cause instanceof LocalTripConflict ? cause.message : message);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function open(trip: OpenLocalTrip) {
    setSelected({ ...trip, plan: assignLocalStopIds(trip.plan) });
    if (trip.id) showAddress(trip.id);
  }

  function startWalk() {
    if (pending.current) return;
    navigation.current++;
    setError("");
    window.history.replaceState(window.history.state, "", "/local?open=walk");
    open({ plan: walkPlan(), walk: true });
  }

  async function select(id: string) {
    return run(async () => {
      const trip = await readLocalTrip(id);
      if (!trip) throw new LocalTripConflict();
      open(trip);
      return trip;
    }, "无法打开这份本机行程。");
  }

  async function commit(
    content: LocalTripContent,
    previous?: OpenLocalTrip,
    consumeDraft?: JournalDraft,
  ) {
    const saved = await run(async () => {
      const version =
        previous?.id && previous.revision
          ? { id: previous.id, revision: previous.revision }
          : undefined;
      const key = localDraftKey(previous);
      const trip = await saveLocalTrip(
        content,
        version,
        key ? { key, consume: consumeDraft } : undefined,
      );
      open(trip);
      return trip;
    }, "未能将改动保存到本机，请检查设备空间后重试。");
    return Boolean(saved);
  }

  async function importBackup(file: File) {
    if (file.size > TRIP_BACKUP_MAX_BYTES) {
      setError("备份文件不能超过 32 MB。");
      return;
    }
    return run(async () => {
      const content = readTripBackup(await file.text());
      try {
        const saved = await restoreLocalTrip(content);
        open(saved);
        return saved;
      } catch {
        open(content);
        setError("行程已打开，但未保存到本机列表。请保留原备份。");
        return content;
      }
    }, "无法读取这个文件。请选择 AI Travel Companion 下载的行程 JSON。");
  }

  async function returnToList() {
    if (pending.current) return;
    showAddress();
    setSelected(undefined);
    await run(async () => {
      const { trips, skipped } = await readSavedTrips();
      setShelf(trips);
      setSkipped(skipped);
    }, "无法刷新本机列表。可重试或打开行程文件。");
  }

  async function remove(trip: LocalTripSummary) {
    await run(async () => {
      await removeLocalTrip(trip);
      setShelf((current) => current.filter((item) => item.id !== trip.id));
    }, "无法从本机移除行程，请重试。");
  }

  async function downloadBackup() {
    if (!selected) return;
    await run(async () => {
      const backup = selected.id ? await readLocalTrip(selected.id, true) : selected;
      if (!backup) throw new LocalTripConflict();
      downloadTripFile(backup.plan, backup);
    }, "无法下载这份备份。");
  }

  return {
    shelf,
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
  };
}
