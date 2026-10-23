import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripsHome } from "@/components/TripsHome";

// 产品入口从营销首页改成「我的行程」后，列表/空态/删除都由这个组件承担。
const STORAGE_KEY = "tp.recent-trips.v1";

describe("我的行程", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("空态：给出新建入口与产品说明", async () => {
    render(<TripsHome />);
    await waitFor(() => expect(screen.getByText("还没有行程")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /新建我的第一份行程/ })).toHaveAttribute(
      "href",
      "/new",
    );
    // 不把「还没有」渲染成一句冷冰冰的空名字：要告诉用户下一步做什么
    expect(screen.getByRole("link", { name: /先看看它是怎么工作的/ })).toHaveAttribute(
      "href",
      "/about",
    );
  });

  it("列出最近行程：链接带 ?edit=1，可移除且只清本地索引", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { shareId: "share_keep01", city: "成都", days: 3, createdAt: Date.now() },
        { shareId: "share_drop02", city: "苏州", days: 2, createdAt: Date.now() - 1000 },
      ]),
    );

    render(<TripsHome />);
    await waitFor(() => expect(screen.getByText("成都")).toBeInTheDocument());

    expect(screen.getByRole("link", { name: /成都/ })).toHaveAttribute(
      "href",
      "/p/share_keep01?edit=1",
    );

    await userEvent.click(screen.getByRole("button", { name: /从我的行程中移除 苏州/ }));
    await waitFor(() => expect(screen.queryByText("苏州")).not.toBeInTheDocument());

    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).toContain("share_keep01");
    expect(raw).not.toContain("share_drop02");
  });
});
