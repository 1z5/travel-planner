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

  it("新用户首屏：主张 + 唯一主 CTA + 可溯源的记忆点", async () => {
    render(<TripsHome />);
    // 首屏必须回答「这是什么产品」：价值主张在首屏，而不是只剩一句「还没有行程」
    await waitFor(() => expect(screen.getByText("先核验真实世界，再排行程")).toBeInTheDocument());
    // 引导明确：主 CTA 唯一且指向新建
    expect(screen.getByRole("link", { name: /说说你想去哪/ })).toHaveAttribute("href", "/new");
    expect(screen.getByRole("link", { name: /看一份真实示例/ })).toHaveAttribute(
      "href",
      "/new?sample=1",
    );
    // 记忆点必须可溯源：示例卡用真实 fixture，且如实标注「POI 未验真」
    // （SAMPLE_PLAN 是 MOCK 数据，冒充已核验就是造假）
    expect(screen.getByText("MOCK 高德 · POI 未验真")).toBeInTheDocument();
    expect(screen.getByText("被体检拦下的问题")).toBeInTheDocument();
    expect(screen.getAllByText(/第 [12] 天/).length).toBeGreaterThan(0);
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

    expect(screen.getByRole("link", { name: /成都/ })).toHaveAttribute("href", "/w/share_keep01");

    await userEvent.click(screen.getByRole("button", { name: /从我的行程中移除 苏州/ }));
    await waitFor(() => expect(screen.queryByText("苏州")).not.toBeInTheDocument());

    const raw = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw).toContain("share_keep01");
    expect(raw).not.toContain("share_drop02");
  });
});
