import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WishlistButton } from "@/components/WishlistButton";
import { loadWishlist } from "@/lib/wishlist";

// 想去按钮：点一下加入、再点移除；状态落 localStorage（未登录也能用）。

const props = {
  shareId: "share_wishbtn01",
  city: "成都",
  days: 3,
  startDate: "2026-11-09",
  summary: "成都 3 天",
};

beforeEach(() => {
  window.localStorage.clear();
});

describe("WishlistButton", () => {
  it("初始未收藏 → 点击加入想去（aria-pressed=true，写入本机）", async () => {
    render(<WishlistButton {...props} />);
    const btn = screen.getByRole("button", { name: /加入想去/ });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(btn);
    expect(screen.getByRole("button", { name: /取消想去/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(loadWishlist().map((t) => t.shareId)).toEqual([props.shareId]);
  });

  it("再次点击 → 移除（幂等切换）", async () => {
    render(<WishlistButton {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /加入想去/ }));
    await userEvent.click(screen.getByRole("button", { name: /取消想去/ }));
    expect(loadWishlist()).toEqual([]);
  });

  it("本机已收藏的行程 → 首帧渲染后显示「已在想去」", async () => {
    // 先通过一次点击写入，再重新挂载（模拟回访）
    const first = render(<WishlistButton {...props} />);
    await userEvent.click(screen.getByRole("button", { name: /加入想去/ }));
    first.unmount();
    render(<WishlistButton {...props} />);
    expect(await screen.findByRole("button", { name: /取消想去/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
