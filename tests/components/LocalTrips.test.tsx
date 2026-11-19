import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LocalTrips } from "@/components/LocalTrips";
import { DEMO_FIXTURES } from "../../demo/fixtures";
import { localTodayIso } from "@/lib/trip/trip-day";
import { readTripFile, serializeTripFile } from "@/lib/trip/trip-file";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
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
    await user.click(screen.getByRole("button", { name: "本机列表" }));
    await user.click(screen.getByRole("button", { name: "从本机移除" }));
    expect(screen.queryByRole("button", { name: "打开今日" })).not.toBeInTheDocument();
  });
});
