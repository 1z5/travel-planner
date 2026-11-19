import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalTrips } from "@/components/LocalTrips";
import { DEMO_FIXTURES } from "../../demo/fixtures";
import { tokyoLocalTrip } from "../../demo/fixtures/tokyo-local";
import { localTodayIso } from "@/lib/trip/trip-day";
import { readTripFile, serializeTripFile } from "@/lib/trip/trip-file";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
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
      expect(() => readTripFile(JSON.stringify({ ...exported, version: 2 }))).toThrow();
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
    await user.click(await screen.findByRole("button", { name: "打开今日" }));
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
    await user.click(await screen.findByRole("button", { name: "打开今日" }));
    expect(hero().getByText("下一站：隅田公园")).toBeInTheDocument();
    expect(screen.getByText("已到达")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "移除旧安田庭园" })).toBeInTheDocument();
    unmount();

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
