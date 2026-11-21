import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { walkPlan } from "@/lib/trip/footprints";
import { LOCAL_TRIPS_KEY } from "@/lib/trip/local-library";
import {
  LocalTripConflict,
  localDraftKey,
  readLocalDraft,
  readLocalPhoto,
  readLocalTrip,
  readSavedTrips,
  removeLocalTrip,
  restoreLocalTrip,
  saveLocalTrip,
  writeLocalDraft,
} from "@/lib/trip/local-trips";
import { readTripBackup, serializeTripFile, TRIP_FILE_MAX_BYTES } from "@/lib/trip/trip-file";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("本机行程库", () => {
  it("首次打卡把草稿转入正式行程，保存手记时一并清理", async () => {
    const content = { plan: walkPlan(), walk: true } as const;
    const key = localDraftKey(content)!;
    const draft = { text: "想记住这条街。", place: "河岸" };
    await writeLocalDraft(key, draft);
    const saved = await saveLocalTrip(content, undefined, { key });
    expect(await readLocalDraft(key)).toBeUndefined();
    expect(await readLocalDraft(saved.id)).toEqual(draft);

    const note = { ...draft, id: crypto.randomUUID(), at: new Date().toISOString() };
    await saveLocalTrip({ ...saved, notes: [note] }, saved, { key: saved.id, consume: draft });
    expect(await readLocalDraft(saved.id)).toBeUndefined();
    expect((await readLocalTrip(saved.id))?.notes).toEqual([note]);
  });
  it("迁移只导入可读条目，保留旧本机地址和原始存档，移除后不会复活", async () => {
    const id = crypto.randomUUID();
    const raw = JSON.stringify([
      "损坏的行程",
      JSON.stringify({ ...JSON.parse(serializeTripFile(walkPlan(), { walk: true })), localId: id }),
    ]);
    localStorage.setItem(LOCAL_TRIPS_KEY, raw);
    const shelf = await readSavedTrips();
    expect(shelf.skipped).toBe(1);
    expect(shelf.trips.map((trip) => trip.id)).toEqual([id]);
    expect((await readLocalTrip(id))?.walk).toBe(true);
    await removeLocalTrip(shelf.trips[0]!);
    expect((await readSavedTrips()).trips).toEqual([]);
    expect(localStorage.getItem(LOCAL_TRIPS_KEY)).toBe(raw);
  });

  it("两个窗口提交同一个版本时只有一方成功，其他行程的内容不受影响", async () => {
    const a = await saveLocalTrip({ plan: walkPlan(), walk: true, title: "散步" });
    const b = await saveLocalTrip({ plan: walkPlan(), walk: true, title: "另一趟" });
    const results = await Promise.allSettled([
      saveLocalTrip({ ...a, title: "沿河" }, a),
      saveLocalTrip({ ...a, title: "沿山" }, a),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")?.reason).toBeInstanceOf(
      LocalTripConflict,
    );
    expect(await readLocalTrip(b.id)).toEqual(b);
    await expect(removeLocalTrip(a)).rejects.toBeInstanceOf(LocalTripConflict);
  });

  it("迁移事务中途失败时保留旧数据，重试只迁移一遍", async () => {
    const raw = JSON.stringify([
      serializeTripFile(walkPlan(), { walk: true, title: "河边" }),
      serializeTripFile(walkPlan(), { walk: true, title: "老街" }),
    ]);
    localStorage.setItem(LOCAL_TRIPS_KEY, raw);
    const originalPut = IDBObjectStore.prototype.put;
    const inject = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === "shelf" && (value as { name: string }).name === "老街")
        throw new DOMException("quota", "QuotaExceededError");
      return originalPut.call(this, value, key);
    });
    try {
      await expect(readSavedTrips()).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(localStorage.getItem(LOCAL_TRIPS_KEY)).toBe(raw);
    } finally {
      inject.mockRestore();
    }
    expect((await readSavedTrips()).trips.map((trip) => trip.name)).toEqual(["河边", "老街"]);
  });

  it("日常保存不受 v1 的 2 MiB 限制，照片按记录读取且导出完整备份", async () => {
    // 用可识别的 JPEG 前缀和填充验证容量，实际图片解码由浏览器流程验证。
    const photo = {
      src: "data:image/jpeg;base64,/9j/" + "A".repeat(120000),
      width: 640,
      height: 480,
    };
    const notes = Array.from({ length: 19 }, (_, index) => ({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      text: `第 ${index + 1} 条手记`,
      photo,
    }));
    const trip = await saveLocalTrip({ plan: walkPlan(), walk: true, notes });
    expect(trip.notes?.every((note) => note.hasPhoto && !note.photo)).toBe(true);
    expect((await readLocalTrip(trip.id))?.notes?.every((note) => !note.photo)).toBe(true);
    expect(await readLocalPhoto(trip.id, notes[0]!.id)).toEqual(photo);
    const complete = (await readLocalTrip(trip.id, true))!;
    const backup = serializeTripFile(complete.plan, complete);
    expect(new Blob([backup]).size).toBeGreaterThan(TRIP_FILE_MAX_BYTES);
    expect(JSON.parse(backup).version).toBe(2);
    expect(JSON.parse(backup)).not.toHaveProperty("id");
    expect(readTripBackup(backup).notes).toEqual(notes);
    const current = await saveLocalTrip({ ...trip, notes: trip.notes?.slice(1) }, trip);
    expect(await readLocalPhoto(trip.id, notes[0]!.id)).toBeUndefined();
    expect(await readLocalPhoto(current.id, notes[1]!.id)).toEqual(photo);

    vi.stubGlobal("indexedDB", new IDBFactory());
    const restored = await restoreLocalTrip(readTripBackup(backup));
    expect(restored.id).not.toEqual(trip.id);
    expect(await readLocalPhoto(restored.id, notes[0]!.id)).toEqual(photo);
  });
});
