import { beforeEach, describe, expect, it } from "vitest";
import {
  addWish,
  isWished,
  loadWishlist,
  removeWish,
  toggleWish,
  type WishlistTrip,
} from "@/lib/wishlist";

// 想去清单：只记用户主动点星的行程；脏数据不炸；幂等；有上限。

const KEY = "tp.wishlist.v1";
const trip = (over: Partial<Omit<WishlistTrip, "addedAt">> = {}) => ({
  shareId: "share_wish01",
  city: "成都",
  days: 3,
  startDate: "2026-11-09",
  summary: "成都 3 天",
  ...over,
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("wishlist", () => {
  it("空清单 / 损坏 JSON / 非数组 → 空数组，不抛错", () => {
    expect(loadWishlist()).toEqual([]);
    window.localStorage.setItem(KEY, "{not json");
    expect(loadWishlist()).toEqual([]);
    window.localStorage.setItem(KEY, JSON.stringify({ shareId: "x" }));
    expect(loadWishlist()).toEqual([]);
  });

  it("加入后能读出，且按加入时间倒序", () => {
    addWish(trip({ shareId: "share_a", city: "成都" }), 1000);
    addWish(trip({ shareId: "share_b", city: "大理" }), 2000);
    const list = loadWishlist();
    expect(list.map((t) => t.shareId)).toEqual(["share_b", "share_a"]);
    expect(list[0]?.city).toBe("大理");
  });

  it("重复加入幂等（不刷新 addedAt、不产生重复条目）", () => {
    addWish(trip(), 1000);
    addWish(trip(), 5000);
    const list = loadWishlist();
    expect(list).toHaveLength(1);
    expect(list[0]?.addedAt).toBe(1000);
  });

  it("toggle：第一次加入，第二次移除", () => {
    expect(toggleWish(trip(), 1000).wished).toBe(true);
    expect(isWished("share_wish01")).toBe(true);
    expect(toggleWish(trip(), 2000).wished).toBe(false);
    expect(isWished("share_wish01")).toBe(false);
  });

  it("remove 只删目标条目", () => {
    addWish(trip({ shareId: "share_a" }), 1000);
    addWish(trip({ shareId: "share_b" }), 2000);
    removeWish("share_a");
    expect(loadWishlist().map((t) => t.shareId)).toEqual(["share_b"]);
  });

  it("脏条目逐条丢弃，好条目保留", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { ...trip({ shareId: "share_ok" }), addedAt: 1 },
        { shareId: "short", city: "x", days: 3, addedAt: 1 }, // shareId 太短
        { ...trip(), days: 99 }, // 天数越界
        { ...trip(), city: "" }, // 空城市
        "not-an-object",
      ]),
    );
    const list = loadWishlist();
    expect(list).toHaveLength(1);
    expect(list[0]?.shareId).toBe("share_ok");
  });

  it("上限 100：超出丢最旧", () => {
    for (let i = 0; i < 105; i += 1) {
      addWish({ shareId: `share_${String(i).padStart(4, "0")}`, city: "城市", days: 2 }, i);
    }
    const list = loadWishlist();
    expect(list).toHaveLength(100);
    // 最旧的 5 条被丢掉
    expect(list.some((t) => t.shareId === "share_0000")).toBe(false);
    expect(list.some((t) => t.shareId === "share_0104")).toBe(true);
  });
});
