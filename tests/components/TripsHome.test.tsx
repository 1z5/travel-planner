import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripsHome } from "@/components/TripsHome";
import { DEMO_SHOWCASE_SHARE_ID } from "@/lib/demo/demo-links";

// 产品入口从营销首页改成「我的行程」后，列表/空态/删除都由这个组件承担。
const STORAGE_KEY = "tp.recent-trips.v1";

describe("我的行程", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("没有行程时，提供新建、体检、样例和城市模板入口", () => {
    render(<TripsHome />);
    expect(screen.getByRole("heading", { name: "我的行程" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "快速开始" })).toHaveAttribute("action", "/new");
    expect(screen.getByRole("button", { name: "开始规划" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /先做体检/ })).toHaveAttribute("href", "/check");
    expect(screen.getByRole("link", { name: /已核验的示例行程/ })).toHaveAttribute(
      "href",
      `/p/${DEMO_SHOWCASE_SHARE_ID}`,
    );
    expect(screen.getByRole("link", { name: /全部城市/ })).toHaveAttribute("href", "/cities");
  });

  it("行中行程排在前面，并能直接打开今日安排", async () => {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { shareId: "share_recent", city: "成都", days: 3, createdAt: Date.now() },
        {
          shareId: "share_active",
          city: "上海",
          days: 3,
          startDate: day,
          createdAt: Date.now() - 1000,
        },
      ]),
    );
    render(<TripsHome />);
    expect(await screen.findByRole("link", { name: "查看今日" })).toHaveAttribute(
      "href",
      "/t/share_active",
    );
    expect(screen.getAllByRole("article")[0]).toHaveTextContent("上海");
  });

  it("最近行程打开工作台，本机移除后可撤销", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { shareId: "share_keep01", city: "成都", days: 3, createdAt: Date.now() },
        { shareId: "share_drop02", city: "苏州", days: 2, createdAt: Date.now() - 1000 },
      ]),
    );

    render(<TripsHome />);
    await waitFor(() => expect(screen.getByRole("link", { name: "成都" })).toBeInTheDocument());

    expect(screen.getByRole("link", { name: "成都" })).toHaveAttribute("href", "/w/share_keep01");

    await userEvent.click(screen.getByRole("button", { name: /从我的行程中移除 苏州/ }));
    await waitFor(() => expect(screen.queryByText("苏州")).not.toBeInTheDocument());

    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).toContain("share_keep01");
    expect(raw).not.toContain("share_drop02");
    await userEvent.click(screen.getByRole("button", { name: "撤销" }));
    expect(screen.getByRole("link", { name: "苏州" })).toBeInTheDocument();
  });
});

describe("想去清单与倒计时", () => {
  const WISH_KEY = "tp.wishlist.v1";
  const TRIPS_KEY = "tp.recent-trips.v1";

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("有想去清单时显示「想去」区块，可移除；没有自己的行程也不算空态", async () => {
    window.localStorage.setItem(
      WISH_KEY,
      JSON.stringify([
        {
          shareId: "share_wish01",
          city: "大理",
          days: 4,
          startDate: "2026-11-20",
          summary: "大理 4 天",
          addedAt: Date.now(),
        },
      ]),
    );
    render(<TripsHome />);
    await waitFor(() => expect(screen.getByText("想去")).toBeInTheDocument());
    // 链接指向分享页
    expect(screen.getByRole("link", { name: "大理" })).toHaveAttribute("href", "/p/share_wish01");
    expect(screen.getByRole("heading", { name: "我的行程" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /从想去清单移除 大理/ }));
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: "大理" })).not.toBeInTheDocument(),
    );
    expect(window.localStorage.getItem(WISH_KEY)).toBe("[]");
  });

  it("行程卡显示行前倒计时（未知日期不显示）", async () => {
    // 未来日期：用相对今天 +30 天，避免写死日期随时间失效
    const d = new Date();
    d.setDate(d.getDate() + 30);
    const startDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    window.localStorage.setItem(
      TRIPS_KEY,
      JSON.stringify([
        { shareId: "share_future", city: "成都", days: 3, startDate, createdAt: Date.now() },
        { shareId: "share_nodate", city: "苏州", days: 2, createdAt: Date.now() },
      ]),
    );
    render(<TripsHome />);
    await waitFor(() => expect(screen.getByText("还有 30 天出发")).toBeInTheDocument());
    // 没有日期的行程不显示倒计时（不猜）
    expect(screen.getAllByText(/还有 \d+ 天出发/)).toHaveLength(1);
  });
});
