import type { Plan } from "@/lib/types";
import type { JournalPhoto } from "./journal-photo";
import {
  parseTripBackup,
  serializeTripFile,
  type JournalEntry,
  type TripProgress,
} from "./trip-file";
import { LOCAL_TRIPS_KEY, localTripId } from "./local-library";

const DATABASE = "tp-local-trips";
const STORES = ["trips", "shelf", "photos", "drafts"] as const;
const MIGRATION = "legacy-import";

export type JournalDraft = { text: string; place: string; photo?: JournalPhoto };
export type LocalJournalEntry = JournalEntry & { hasPhoto?: boolean };
export type LocalTripContent = Omit<TripProgress, "notes"> & {
  plan: Plan;
  notes?: LocalJournalEntry[];
};
type TripVersion = { id: string; revision: string };
export type LocalTrip = LocalTripContent & TripVersion;
type PhotoRecord = { tripId: string; noteId: string; photo: JournalPhoto };
export type LocalTripSummary = TripVersion & {
  name: string;
  city: string;
  walk?: true;
  date?: string;
  days: number;
  lastPlace?: string;
  updatedAt: number;
};

function summary(trip: LocalTrip, updatedAt = Date.now()): LocalTripSummary {
  return {
    id: trip.id,
    revision: trip.revision,
    name: trip.title ?? trip.plan.city,
    city: trip.plan.city,
    walk: trip.walk,
    date: trip.plan.startDate,
    days: trip.plan.days.length,
    lastPlace: Object.values(trip.arrivals ?? {}).at(-1)?.place ?? trip.notes?.[0]?.place,
    updatedAt,
  };
}

function writeTrip(
  transaction: IDBTransaction,
  content: LocalTripContent,
  id: string,
  previous?: LocalTrip,
  updatedAt?: number,
): LocalTrip {
  const { plan, marks, arrivals, walk, title } = content;
  const photos = transaction.objectStore("photos");
  const oldNotes = new Map(previous?.notes?.map((note) => [note.id, note.hasPhoto]));
  const notes = content.notes?.map(({ photo, hasPhoto: _hasPhoto, ...note }) => {
    if (photo) photos.put({ tripId: id, noteId: note.id, photo } satisfies PhotoRecord);
    const hasPhoto = !!photo || oldNotes.get(note.id);
    oldNotes.delete(note.id);
    return hasPhoto ? { ...note, hasPhoto: true } : note;
  });
  for (const [noteId, hasPhoto] of oldNotes) {
    if (hasPhoto) photos.delete([id, noteId]);
  }
  const trip = { id, revision: crypto.randomUUID(), plan, marks, arrivals, walk, title, notes };
  transaction.objectStore("trips").put(trip);
  transaction.objectStore("shelf").put(summary(trip, updatedAt));
  return trip;
}

function migrateLegacy(transaction: IDBTransaction) {
  let skipped = 0;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_TRIPS_KEY) ?? "[]");
    if (!Array.isArray(value)) throw new Error("旧行程库格式错误");
    const seen = new Set<string>();
    const timestamp = Date.now();
    for (const [index, raw] of value.entries()) {
      let content: ReturnType<typeof parseTripBackup>;
      let existingId: string | undefined;
      try {
        if (typeof raw !== "string") throw new Error("旧行程格式错误");
        const parsed: unknown = JSON.parse(raw);
        content = parseTripBackup(parsed);
        existingId = localTripId(parsed);
      } catch {
        skipped++;
        continue;
      }
      const id = existingId && !seen.has(existingId) ? existingId : crypto.randomUUID();
      seen.add(id);
      writeTrip(transaction, content, id, undefined, timestamp - index);
    }
  } catch (error) {
    // 事务错误必须中止，避免留下半套记录。旧数据仍可在下次启动时迁移。
    if (
      !(error instanceof SyntaxError) &&
      !(error instanceof Error && error.message === "旧行程库格式错误")
    ) {
      throw error;
    }
    skipped++;
  }
  transaction.objectStore("settings").put(skipped, MIGRATION);
}

let connection: { factory: IDBFactory; result: Promise<IDBDatabase> } | undefined;

function database(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error("此浏览器无法打开本机行程库"));
  if (connection?.factory === factory) return connection.result;
  const result = new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE, 2);
    let migrationError: unknown;
    request.onupgradeneeded = ({ oldVersion }) => {
      const db = request.result;
      db.createObjectStore("drafts");
      if (oldVersion > 0) return;
      db.createObjectStore("trips", { keyPath: "id" });
      db.createObjectStore("shelf", { keyPath: "id" });
      db.createObjectStore("photos", { keyPath: ["tripId", "noteId"] }).createIndex(
        "tripId",
        "tripId",
      );
      db.createObjectStore("settings");
      try {
        migrateLegacy(request.transaction!);
      } catch (error) {
        migrationError = error;
        request.transaction?.abort();
      }
    };
    request.onerror = () => reject(migrationError ?? request.error);
    request.onblocked = () => reject(new Error("请关闭其他打开此应用的标签页后重试"));
    request.onsuccess = () => {
      const db = request.result;
      if (connection?.result !== result) {
        db.close();
        return;
      }
      db.onversionchange = db.onclose = () => {
        db.close();
        if (connection?.result === result) connection = undefined;
      };
      resolve(db);
    };
  });
  connection = { factory, result };
  void result.catch(() => {
    if (connection?.result === result) connection = undefined;
  });
  return result;
}

function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readSavedTrips(): Promise<{ trips: LocalTripSummary[]; skipped: number }> {
  const db = await database();
  const tx = db.transaction(["shelf", "settings"]);
  const [trips, skipped]: [LocalTripSummary[], number] = await Promise.all([
    read(tx.objectStore("shelf").getAll()),
    read(tx.objectStore("settings").get(MIGRATION)),
  ]);
  return { trips: trips.sort((a, b) => b.updatedAt - a.updatedAt), skipped };
}

export async function readLocalTrip(
  id: string,
  includePhotos = false,
): Promise<LocalTrip | undefined> {
  const db = await database();
  const tx = db.transaction(includePhotos ? ["trips", "photos"] : ["trips"]);
  const tripRequest = read<LocalTrip | undefined>(tx.objectStore("trips").get(id));
  if (!includePhotos) return tripRequest;
  const [trip, photos] = await Promise.all([
    tripRequest,
    read<PhotoRecord[]>(tx.objectStore("photos").index("tripId").getAll(id)),
  ]);
  if (!trip) return;
  const byNote = new Map(photos.map(({ noteId, photo }) => [noteId, photo]));
  return { ...trip, notes: trip.notes?.map((note) => ({ ...note, photo: byNote.get(note.id) })) };
}

export async function readLocalPhoto(
  id: string,
  noteId: string,
): Promise<JournalPhoto | undefined> {
  const db = await database();
  const photo = await read<PhotoRecord | undefined>(
    db.transaction("photos").objectStore("photos").get([id, noteId]),
  );
  return photo?.photo;
}

export function localDraftKey(trip?: { id?: string; walk?: true; plan: Plan }): string | undefined {
  if (!trip) return;
  return trip.id ?? (trip.walk ? "new:walk" : `new:${trip.plan.city}:${trip.plan.startDate ?? ""}`);
}

export async function readLocalDraft(key: string): Promise<JournalDraft | undefined> {
  const db = await database();
  return read(db.transaction("drafts").objectStore("drafts").get(key));
}

export async function writeLocalDraft(key: string, draft: JournalDraft): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("草稿保存已中断"));
    const store = tx.objectStore("drafts");
    if (draft.text || draft.place || draft.photo) store.put(draft, key);
    else store.delete(key);
  });
}

export class LocalTripConflict extends Error {
  constructor() {
    super("这份行程已在其他窗口更改，请重新打开。");
  }
}

// 在同一读写事务中验证版本并提交，确保两页不会从同一版本各自覆盖对方。
async function changeTrip<T>(
  id: string,
  version: TripVersion | undefined,
  change: (tx: IDBTransaction, existing?: LocalTrip) => T,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...STORES], "readwrite");
    let result: T;
    let failure: unknown;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(failure ?? tx.error ?? new Error("本机保存已中断"));
    const current = tx.objectStore("trips").get(id);
    current.onsuccess = () => {
      try {
        const existing: LocalTrip | undefined = current.result;
        if (version && existing?.revision !== version.revision) throw new LocalTripConflict();
        result = change(tx, existing);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
  });
}

export async function saveLocalTrip(
  content: LocalTripContent,
  version?: TripVersion,
  draft?: { key: string; consume?: JournalDraft },
): Promise<LocalTrip> {
  const id = version?.id ?? crypto.randomUUID();
  return changeTrip(id, version, (tx, existing) => {
    if (draft) {
      const store = tx.objectStore("drafts");
      if (draft.consume || draft.key !== id) {
        const oldDraft = store.get(draft.key);
        oldDraft.onsuccess = () => {
          const saved: JournalDraft | undefined = oldDraft.result;
          if (!saved) return;
          const consume = draft.consume;
          if (
            consume &&
            (saved.text !== consume.text ||
              saved.place !== consume.place ||
              saved.photo?.src !== consume.photo?.src)
          )
            return; // 另一窗口可能已经写入较新的草稿。
          if (!consume) store.put(saved, id);
          store.delete(draft.key);
        };
      }
    }
    return writeTrip(tx, content, id, existing);
  });
}

export async function restoreLocalTrip(content: LocalTripContent): Promise<LocalTrip> {
  const source = serializeTripFile(content.plan, content);
  const { trips } = await readSavedTrips();
  for (const { id, city } of trips) {
    if (city !== content.plan.city) continue;
    const saved = await readLocalTrip(id, true);
    if (!saved) continue;
    try {
      if (serializeTripFile(saved.plan, saved) === source) return saved;
    } catch {
      // 单份本机记录可能已经超过备份上限，仍可以导入另一份行程。
    }
  }
  return saveLocalTrip({ ...content, plan: assignLocalStopIds(content.plan) });
}

export async function removeLocalTrip(trip: TripVersion) {
  await changeTrip(trip.id, trip, (tx, existing) => {
    tx.objectStore("trips").delete(trip.id);
    tx.objectStore("shelf").delete(trip.id);
    tx.objectStore("drafts").delete(trip.id);
    for (const note of existing?.notes ?? []) {
      if (note.hasPhoto) tx.objectStore("photos").delete([trip.id, note.id]);
    }
  });
}
export function assignLocalStopIds(plan: Plan): Plan {
  const seen = new Set<string>();
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      spots: day.spots.map((spot) => {
        const stopId = spot.stopId && !seen.has(spot.stopId) ? spot.stopId : crypto.randomUUID();
        seen.add(stopId);
        return { ...spot, stopId };
      }),
    })),
  };
}
