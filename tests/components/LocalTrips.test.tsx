import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { readLocalTrip, readSavedTrips } from "@/lib/trip/local-trips";
import { LocalTrips } from "@/components/LocalTrips";
import { DEMO_FIXTURES } from "../../demo/fixtures";
import { tokyoLocalTrip } from "../../demo/fixtures/tokyo-local";
import { localTodayIso } from "@/lib/trip/trip-day";
import { walkPlan } from "@/lib/trip/footprints";

import { readTripBackup, readTripFile, serializeTripFile } from "@/lib/trip/trip-file";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
});

async function savedTrip() {
  const first = (await readSavedTrips()).trips[0]!;
  return (await readLocalTrip(first.id, true))!;
}

afterEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("随走", () => {
  it("同一天的两本手记各自有固定地址，重开较早的一本不会跳到最近写过的那本", async () => {
    const user = userEvent.setup();
    const first = render(<LocalTrips />);

    async function startAt(place: string) {
      const start = screen.getByRole("button", { name: "开始随走" });
      await waitFor(() => expect(start).toBeEnabled());
      await user.click(start);
      await user.type(screen.getByLabelText("地点名称"), place);
      await user.click(screen.getByRole("button", { name: "记录停留" }));
      await screen.findByText(`已记下 · ${place}`);
      return window.location.search;
    }

    const firstAddress = await startAt("河边书店");
    await user.click(screen.getByText("命名手记", { selector: "summary" }));
    await user.type(screen.getByLabelText("手记标题"), "沿着河走");
    await user.click(screen.getByRole("button", { name: "保存标题" }));
    expect(await screen.findByRole("heading", { name: "沿着河走" })).toBeInTheDocument();
    expect(window.location.search).toBe(firstAddress);
    await user.click(screen.getByRole("button", { name: "本机列表" }));
    const secondAddress = await startAt("旧桥");
    expect(firstAddress).toMatch(/^\?trip=/);
    expect(firstAddress).not.toBe(secondAddress);
    first.unmount();

    window.history.replaceState(null, "", `/local${firstAddress}`);
    render(<LocalTrips />);
    expect(await screen.findByRole("heading", { name: "沿着河走" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "河边书店" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "旧桥" })).toBeNull();
  });

  it("从旧条目进入后补上地址，保持本机库的顺序和原有记录", async () => {
    const trip = walkPlan();
    const files = [
      serializeTripFile(tokyoLocalTrip()),
      serializeTripFile(trip, {
        walk: true,
        arrivals: { [crypto.randomUUID()]: { place: "旧照片里的车站" } },
      }),
    ];
    localStorage.setItem("tp.local-trip-files.v1", JSON.stringify(files));
    render(<LocalTrips />);
    await userEvent.click(await screen.findByRole("button", { name: "打开手记" }));
    expect(await screen.findByRole("heading", { name: "旧照片里的车站" })).toBeInTheDocument();
    const { trips } = await readSavedTrips();
    expect(trips[0]?.city).toBe("东京");
    const upgraded = (await readLocalTrip(trips[1]!.id, true))!;
    expect(upgraded.arrivals).toEqual(readTripBackup(files[1]!).arrivals);
    expect(window.location.search).toBe(`?trip=${upgraded.id}`);
    expect(localStorage.getItem("tp.local-trip-files.v1")).toBe(JSON.stringify(files));
  });

  it("无需计划，记录带位置的停留，给同一地点写手记，并从备份恢复", async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) =>
      success({
        coords: { latitude: 35.71, longitude: 139.8, accuracy: 18 },
      } as GeolocationPosition),
    );
    const previous = Object.getOwnPropertyDescriptor(navigator, "geolocation");
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    try {
      const user = userEvent.setup();
      window.history.replaceState(null, "", "/local?open=walk");
      const { unmount } = render(<LocalTrips />);
      expect(await screen.findByRole("heading", { name: "随走手记" })).toBeInTheDocument();
      expect(localStorage.getItem("tp.local-trip-files.v1")).toBeNull();
      expect(getCurrentPosition).not.toHaveBeenCalled();
      await user.type(screen.getByLabelText("地点名称"), "河边书店");
      await user.click(screen.getByRole("button", { name: "附上此刻位置" }));
      expect(screen.getByText(/误差约 18 米/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "记录停留" }));
      const mapPin = await screen.findByRole("link", { name: "查看足迹：河边书店" });
      expect(document.querySelector(mapPin.getAttribute("href")!)).toHaveTextContent("河边书店");
      await user.click(screen.getByRole("button", { name: "为这里写手记" }));
      expect(screen.getByLabelText("关联地点")).toHaveValue("河边书店");
      await user.type(screen.getByLabelText("记下这一刻"), "走到桥下才发现这家店。");
      await user.click(screen.getByRole("button", { name: "保存手记" }));
      const backup = await savedTrip();
      const raw = serializeTripFile(backup.plan, backup);
      expect(backup).toMatchObject({ walk: true, notes: [{ place: "河边书店" }] });
      expect(Object.values(backup.arrivals!)).toEqual([
        {
          place: "河边书店",
          at: expect.any(String),
          position: { lat: 35.71, lng: 139.8, accuracy: 18 },
        },
      ]);
      expect(backup.plan.days[0]?.spots).toEqual([]);
      expect(JSON.parse(serializeTripFile(backup.plan))).not.toHaveProperty("arrivals");
      unmount();

      localStorage.clear();
      vi.stubGlobal("indexedDB", new IDBFactory());
      window.history.replaceState(null, "", "/local");
      render(<LocalTrips />);
      await user.upload(screen.getByLabelText("导入行程文件"), new File([raw], "walk.json"));
      expect(await screen.findByRole("heading", { name: "随走手记" })).toBeInTheDocument();
      expect(screen.getByText("走到桥下才发现这家店。")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "查看足迹：河边书店" })).toBeInTheDocument();
    } finally {
      if (previous) Object.defineProperty(navigator, "geolocation", previous);
      else Reflect.deleteProperty(navigator, "geolocation");
    }
  });

  it("定位拒绝后仍可保存，已取消的定位不会混入下一条记录", async () => {
    let locate: PositionCallback | undefined;
    let denied: PositionErrorCallback | null | undefined;
    const previous = Object.getOwnPropertyDescriptor(navigator, "geolocation");
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback, error: PositionErrorCallback) => {
          locate = ok;
          denied = error;
        },
      },
    });
    try {
      const user = userEvent.setup();
      render(<LocalTrips />);
      await user.click(screen.getByRole("button", { name: "开始随走" }));
      await user.click(screen.getByRole("button", { name: "附上此刻位置" }));
      act(() => denied?.({ code: 1 } as GeolocationPositionError));
      expect(screen.getByText(/定位权限未开启/)).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "附上此刻位置" }));
      await user.click(screen.getByRole("button", { name: "取消定位" }));
      act(() =>
        locate?.({ coords: { latitude: 35, longitude: 139, accuracy: 18 } } as GeolocationPosition),
      );
      await user.type(screen.getByLabelText("地点名称"), "旧桥");
      await user.click(screen.getByRole("button", { name: "记录停留" }));
      expect(await screen.findByText("已记下 · 旧桥")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "查看足迹：旧桥" })).toBeNull();
    } finally {
      if (previous) Object.defineProperty(navigator, "geolocation", previous);
      else Reflect.deleteProperty(navigator, "geolocation");
    }
  });
});

it("新建巴黎计划后使用当地时区、内置地点和官方出处", async () => {
  vi.setSystemTime(new Date("2026-07-10T06:00:00Z"));
  const user = userEvent.setup();
  render(<LocalTrips />);
  await user.click(screen.getByText("手动新建行程"));
  await user.type(screen.getByLabelText("目的地"), "Paris");
  fireEvent.change(screen.getByLabelText("出发日期"), { target: { value: "2026-07-10" } });
  await user.click(screen.getByRole("button", { name: "创建本机行程" }));
  await user.selectOptions(await screen.findByLabelText("从巴黎城市包添加"), "louvre");
  fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "09:00" } });
  fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "10:00" } });
  await user.click(screen.getByRole("button", { name: "添加站点" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "今日" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "今日" }));
  expect(await screen.findByText("当地时间 08:00 · Europe/Paris")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "卢浮宫官网" })).toHaveAttribute(
    "href",
    "https://www.louvre.fr/en/visit",
  );
});

describe("本机行程文件", () => {
  it("保留示例行程的日期、站点和顺序，忽略文件里的受信字段", () => {
    for (const { plan } of DEMO_FIXTURES) {
      const exported = JSON.parse(serializeTripFile(plan));
      exported.plan.verified = true;
      exported.plan.demo = true;
      const restored = readTripFile(JSON.stringify(exported));
      expect(restored.startDate).toBe(plan.startDate);
      expect(restored.days.map((day) => day.spots.map((spot) => [spot.name, spot.time]))).toEqual(
        plan.days.map((day) => day.spots.map((spot) => [spot.name, spot.time])),
      );
      expect(restored.verified).toBe(false);
      expect(restored.demo).toBeUndefined();
      expect(() => readTripFile(JSON.stringify({ ...exported, version: 3 }))).toThrow();
    }
  });

  it("导入后直接打开今日，重开从本机加载，无需请求分享接口", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const plan = { ...DEMO_FIXTURES[0]!.plan, startDate: localTodayIso() };
    const file = new File([serializeTripFile(plan)], "test.trip.json", {
      type: "application/json",
    });
    const user = userEvent.setup();
    const { unmount } = render(<LocalTrips />);
    await user.upload(screen.getByLabelText("导入行程文件"), file);
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "跳过" })[0]!);
    expect(screen.getByText("已跳过")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    render(<LocalTrips />);
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    expect(screen.getByText("已跳过")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.queryByText("已跳过")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "完整行程" }));
    expect(await screen.findByText("来自行程文件 · 未重新核验")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "本机列表" }));
    await user.click(screen.getByRole("button", { name: "从本机移除" }));
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    expect(screen.queryByRole("button", { name: "打开今日" })).not.toBeInTheDocument();
  });

  it("按东京当地日期打开下一站，编辑与撤销同步，重新打开保留到达记录", async () => {
    const now = new Date("2026-11-18T15:30:00Z");
    vi.setSystemTime(now);
    const plan = tokyoLocalTrip(now);
    expect(plan.startDate).toBe("2026-11-19");
    const user = userEvent.setup();
    const { unmount } = render(<LocalTrips />);
    const file = new File([serializeTripFile(plan)], "tokyo.trip.json");
    await user.upload(screen.getByLabelText("导入行程文件"), file);

    function hero() {
      return within(screen.getByText("当地时间 00:30 · Asia/Tokyo").closest("section")!);
    }

    await screen.findByText("今日时间轴");
    expect(screen.getByText("地点来源 2/2 · 开放时间资料 1/2")).toBeInTheDocument();
    const check = screen.getByText("离线行程体检").closest("details")!;
    await user.click(screen.getByText("离线行程体检"));
    expect(await within(check).findByRole("heading", { name: "结构自洽性" })).toBeInTheDocument();
    expect(within(check).getByText("部分核验")).toBeInTheDocument();
    expect(within(check).getByRole("link", { name: "台东区官方观光网站" })).toBeInTheDocument();
    expect(hero().getByText(/第一站：浅草寺/)).toBeInTheDocument();
    expect(hero().getByRole("link", { name: "浅草寺官网" })).toHaveAttribute(
      "href",
      "https://www.senso-ji.jp/visit/",
    );
    const nav = hero().getByRole("link", { name: "导航到这里" });
    expect(new URL((nav as HTMLAnchorElement).href).searchParams.get("destination")).toBe(
      plan.days[0]!.spots[0]!.navigationQuery,
    );
    await user.click(screen.getByRole("button", { name: "编辑本机计划" }));
    await user.click(screen.getByRole("button", { name: "移除浅草寺" }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(hero().getByText(/第一站：隅田公园/)).toBeInTheDocument();
    expect(hero().getByText(/开放时间未知/)).toBeInTheDocument();
    expect(hero().getByRole("link", { name: "台东区官方观光网站" })).toBeInTheDocument();
    expect(hero().getByText("前往本站的交通时长未知")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "编辑本机计划" }));
    await user.click(screen.getByRole("button", { name: "撤销上次编辑" }));
    await user.click(screen.getByRole("button", { name: "今日" }));
    await user.click(hero().getByRole("button", { name: "我已到达" }));
    expect(hero().getByText("下一站：隅田公园")).toBeInTheDocument();
    expect(hero().getByText(/步行约 11 分钟（行程文件参考）/)).toBeInTheDocument();
    unmount();

    render(<LocalTrips />);
    await screen.findByText("今日时间轴");
    expect(hero().getByText("下一站：隅田公园")).toBeInTheDocument();
    expect(screen.getByText("已到达")).toBeInTheDocument();
    await user.click(hero().getByRole("button", { name: "计划外停留" }));
    await user.type(screen.getByLabelText("地点名称"), "桥下咖啡店");
    await user.click(screen.getByRole("button", { name: "记录停留" }));
    expect(screen.getByRole("heading", { name: "桥下咖啡店" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(hero().getByText("下一站：隅田公园")).toBeInTheDocument();
    expect(screen.queryByText("桥下咖啡店")).not.toBeInTheDocument();
  });

  it("从东京城市包添加站点，开放时间出处随本机行程保留", async () => {
    const now = new Date("2026-11-18T15:30:00Z");
    vi.setSystemTime(now);
    const user = userEvent.setup();
    const { unmount } = render(<LocalTrips />);
    await user.upload(
      screen.getByLabelText("导入行程文件"),
      new File([serializeTripFile(tokyoLocalTrip(now))], "tokyo.trip.json"),
    );
    await screen.findByText("今日时间轴");
    await user.click(screen.getByRole("button", { name: "编辑本机计划" }));
    await user.selectOptions(screen.getByLabelText("从东京城市包添加"), "former-yasuda-garden");
    expect(screen.queryByLabelText("站点名称")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("开始时间"), { target: { value: "08:00" } });
    fireEvent.change(screen.getByLabelText("结束时间"), { target: { value: "08:45" } });
    await user.click(screen.getByRole("button", { name: "添加站点" }));
    expect(await screen.findByRole("button", { name: "移除旧安田庭园" })).toBeInTheDocument();
    unmount();

    window.history.replaceState(null, "", "/local");
    render(<LocalTrips />);
    await user.click(await screen.findByRole("button", { name: "打开今日" }));
    expect(await screen.findByText("地点来源 3/3 · 开放时间资料 2/3")).toBeInTheDocument();
    const hero = within(screen.getByText("当地时间 00:30 · Asia/Tokyo").closest("section")!);
    expect(hero.getByRole("link", { name: "墨田区官网" })).toHaveAttribute(
      "href",
      "https://www.city.sumida.lg.jp/sisetu_info/kouen/kunai_park_annai/sumida_park/park08.html",
    );
  });

  it("拒绝无效时区和可执行的营业时间来源链接", () => {
    const json = JSON.parse(serializeTripFile(tokyoLocalTrip()));
    expect(() =>
      readTripFile(
        JSON.stringify({
          ...json,
          plan: { ...json.plan, timeZone: "Asia/NoSuchCity" },
        }),
      ),
    ).toThrow();
    json.plan.days[0].spots[0].openingHoursNote.url = "javascript:alert(1)";
    expect(() => readTripFile(JSON.stringify(json))).toThrow();
  });
});

describe("随身手记", () => {
  it("步行示例只在操作后保存，手记可以回看、单独备份并移除", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/local?open=tokyo");
    try {
      const { unmount } = render(<LocalTrips />);
      await screen.findByText("今日时间轴");
      expect(localStorage.getItem("tp.local-trip-files.v1")).toBeNull();
      await user.selectOptions(screen.getByLabelText("查看路线站点"), "1");
      await user.click(screen.getByRole("button", { name: "在本站写手记" }));
      expect(screen.getByLabelText("关联地点")).toHaveValue("隅田公园");
      await user.type(screen.getByLabelText("记下这一刻"), "在河边看到了水鸟。");
      await user.click(screen.getByRole("button", { name: "今日" }));
      await user.click(screen.getByRole("button", { name: "手记" }));
      expect(screen.getByLabelText("记下这一刻")).toHaveValue("在河边看到了水鸟。");
      await user.click(screen.getByRole("button", { name: "保存手记" }));
      expect(await screen.findByText("这一刻已保存到本机")).toBeInTheDocument();
      const { plan, notes } = await savedTrip();
      expect(notes).toHaveLength(1);
      expect(notes?.[0]?.place).toBe("隅田公园");
      expect(serializeTripFile(plan)).not.toContain("水鸟");
      expect(screen.getByRole("button", { name: "下载含进展的备份" })).toBeInTheDocument();
      unmount();
      render(<LocalTrips />);
      await user.click(await screen.findByRole("button", { name: "手记" }));
      expect(screen.getByText("在河边看到了水鸟。")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "移除手记" }));
      await user.click(screen.getByRole("button", { name: "确认移除" }));
      await waitFor(() => expect(screen.queryByText("在河边看到了水鸟。")).not.toBeInTheDocument());
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("存储失败时保留手记草稿，并说明未保存", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/local?open=tokyo");
    try {
      render(<LocalTrips />);
      await user.click(await screen.findByRole("button", { name: "手记" }));
      await user.type(screen.getByLabelText("记下这一刻"), "还没有保存");
      await readSavedTrips();
      const failedWrite = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
        throw new Error("quota");
      });
      try {
        await user.click(screen.getByRole("button", { name: "保存手记" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("未能将改动保存到本机");
        expect(screen.getByLabelText("记下这一刻")).toHaveValue("还没有保存");
        expect(screen.queryByText("这一刻已保存到本机")).not.toBeInTheDocument();
      } finally {
        failedWrite.mockRestore();
      }
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });
});

describe("到达和照片手记", () => {
  it("刚到的站可直接补记，计划外地点独立保存，删站后保留足迹，主动撤销后不会随编辑撤销复活", async () => {
    const now = new Date("2026-11-18T15:30:00Z");
    vi.setSystemTime(now);
    const user = userEvent.setup();
    render(<LocalTrips />);
    await user.upload(
      screen.getByLabelText("导入行程文件"),
      new File([serializeTripFile(tokyoLocalTrip(now))], "trip.json"),
    );
    const hero = (await screen.findByText("当地时间 00:30 · Asia/Tokyo")).closest("section")!;
    await user.click(within(hero).getByRole("button", { name: "我已到达" }));
    expect(await within(hero).findByText("下一站：隅田公园")).toBeInTheDocument();
    await user.click(within(hero).getByRole("button", { name: "记下刚才这一站" }));
    const place = screen.getByLabelText("关联地点");
    expect(place).toHaveValue("浅草寺");
    await user.clear(place);
    await user.type(place, "河边书店");
    await user.type(screen.getByLabelText("记下这一刻"), "偶遇一间书店");
    await user.click(screen.getByRole("button", { name: "保存手记" }));
    const read = savedTrip;
    const stopId = (await read()).plan.days[0]!.spots[0]!.stopId!;
    expect((await read()).arrivals?.[stopId]).toEqual({ place: "浅草寺", at: now.toISOString() });
    expect((await read()).notes?.[0]?.place).toBe("河边书店");
    expect(serializeTripFile((await read()).plan)).not.toContain("河边书店");
    await user.click(screen.getByRole("button", { name: "编辑本机计划" }));
    await user.click(screen.getByRole("button", { name: "移除浅草寺" }));
    expect((await read()).arrivals?.[stopId]?.place).toBe("浅草寺");
    await user.click(screen.getByRole("button", { name: "手记" }));
    expect(screen.getByRole("heading", { name: "浅草寺" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "撤销打卡" }));
    await user.click(screen.getByRole("button", { name: "确认移除" }));
    await user.click(screen.getByRole("button", { name: "编辑本机计划" }));
    await user.click(screen.getByRole("button", { name: "撤销上次编辑" }));
    expect((await read()).marks?.[stopId]).toBeUndefined();
    expect((await read()).arrivals?.[stopId]).toBeUndefined();
    expect((await read()).notes?.[0]?.text).toBe("偶遇一间书店");
  });

  it("旧备份不会补造打卡时间，外部图片地址和超长图片字段不能导入", async () => {
    const plan = tokyoLocalTrip();
    const id = crypto.randomUUID();
    plan.days[0]!.spots[0]!.stopId = id;
    render(<LocalTrips />);
    const backup = serializeTripFile(plan, { marks: { [id]: "arrived" } });
    await userEvent.upload(
      screen.getByLabelText("导入行程文件"),
      new File([backup], "legacy.json"),
    );
    await userEvent.click(await screen.findByRole("button", { name: "手记" }));
    expect(screen.getByRole("heading", { name: "时间未记录" })).toBeInTheDocument();
    const json = JSON.parse(backup);
    for (const src of [
      "https://example.org/private.jpg",
      "data:image/svg+xml;base64,AAAA",
      "data:image/jpeg;base64,/9j/" + "A".repeat(140000),
    ]) {
      json.notes = [
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          text: "照片",
          photo: { src, width: 200, height: 200 },
        },
      ];
      expect(() => readTripBackup(JSON.stringify(json))).toThrow();
    }
  });
});
