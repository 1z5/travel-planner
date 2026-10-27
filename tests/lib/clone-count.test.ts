import { describe, expect, it } from "vitest";
import type { TripEventRecord } from "@/lib/store/types";
import { countClones } from "@/lib/clone-count";

// 克隆计数：分享页社交证明的口径。0 次不渲染、同 shareId 才计数、其它事件不混入。

function ev(over: Partial<TripEventRecord>): TripEventRecord {
  return { id: "e1", name: "plan_created", createdAt: Date.now(), ...over };
}

describe("countClones", () => {
  it("没有克隆记录 → 0（UI 整块不渲染，不编数字）", () => {
    expect(countClones([], "share_a")).toBe(0);
    expect(countClones([ev({ name: "plan_created", shareId: "share_a" })], "share_a")).toBe(0);
  });

  it("只数目标行程的 trip_cloned", () => {
    const events = [
      ev({ id: "1", name: "trip_cloned", shareId: "share_a" }),
      ev({ id: "2", name: "trip_cloned", shareId: "share_b" }),
      ev({ id: "3", name: "trip_cloned", shareId: "share_a" }),
      ev({ id: "4", name: "plan_opened", shareId: "share_a" }),
    ];
    expect(countClones(events, "share_a")).toBe(2);
    expect(countClones(events, "share_b")).toBe(1);
    expect(countClones(events, "share_c")).toBe(0);
  });

  it("不修改传入数组", () => {
    const events = [ev({ id: "1", name: "trip_cloned", shareId: "s" })];
    const before = JSON.stringify(events);
    countClones(events, "s");
    expect(JSON.stringify(events)).toBe(before);
  });
});
