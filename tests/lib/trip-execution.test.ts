import { beforeEach, describe, expect, it } from "vitest";
import {
  arrivedSpotNames,
  departureAdvice,
  loadDayExecution,
  loadExecutionLog,
  markArrived,
  markDeparted,
} from "@/lib/trip-execution";
import type { PlanLeg, PlanSpot } from "@/lib/types";

// 行中打卡：本地存储的 CRUD、脏数据防御、以及「没有真实路段就不给出发建议」。

function spot(over: Partial<PlanSpot> = {}): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:30",
    type: "sight",
    name: "拙政园",
    area: "姑苏区",
    durationMin: 90,
    costCny: 80,
    reason: "经典园林",
    ...over,
  };
}

function leg(over: Partial<PlanLeg> = {}): PlanLeg {
  return {
    from: "苏州博物馆",
    to: "拙政园",
    mode: "walking",
    distanceM: 800,
    durationSec: 720,
    steps: ["向东步行"],
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("departureAdvice", () => {
  it("有真实路段：建议出发 = 下一站开始 - 通勤 - 缓冲", () => {
    // 下一站 09:00 开始；步行 12 分钟 + 缓冲 5 分钟 → 08:43 出发
    const a = departureAdvice(8 * 60, spot({ time: "09:00-10:30" }), leg({ durationSec: 720 }));
    expect(a).toEqual({ departAt: "08:43", transitMin: 12, bufferMin: 5, mode: "walking" });
  });

  it("驾车缓冲更大（10 分钟）", () => {
    const a = departureAdvice(
      8 * 60,
      spot({ time: "09:00-10:30" }),
      leg({ mode: "driving", durationSec: 1800 }),
    );
    expect(a).toEqual({ departAt: "08:20", transitMin: 30, bufferMin: 10, mode: "driving" });
  });

  it("已过建议出发时间 → 建议「现在就走」，不把时间倒回过去", () => {
    const a = departureAdvice(9 * 60 + 30, spot({ time: "09:00-10:30" }), leg());
    expect(a?.departAt).toBe("09:30");
  });

  it("没有真实路段 → null（不拿估算值给建议）", () => {
    expect(departureAdvice(8 * 60, spot(), undefined)).toBeNull();
  });

  it("下一站时间不可解析 → null（不猜）", () => {
    expect(departureAdvice(8 * 60, spot({ time: "待定" }), leg())).toBeNull();
  });
});

describe("打卡存储", () => {
  it("出发/到达可分别记录，到达会补出发时间", () => {
    markDeparted("share_a", 1, "拙政园", 1000);
    let dayExec = loadDayExecution("share_a", 1);
    expect(dayExec["拙政园"]).toEqual({ departedAt: 1000 });

    markArrived("share_a", 1, "拙政园", 2000);
    dayExec = loadDayExecution("share_a", 1);
    expect(dayExec["拙政园"]).toEqual({ departedAt: 1000, arrivedAt: 2000 });
  });

  it("重复点击不覆盖首次时间（幂等）", () => {
    markArrived("share_a", 1, "拙政园", 1000);
    markArrived("share_a", 1, "拙政园", 9999);
    expect(loadDayExecution("share_a", 1)["拙政园"]?.arrivedAt).toBe(1000);
  });

  it("按 shareId + day 隔离", () => {
    markArrived("share_a", 1, "拙政园", 1000);
    expect(loadDayExecution("share_b", 1)).toEqual({});
    expect(loadDayExecution("share_a", 2)).toEqual({});
    expect(arrivedSpotNames(loadDayExecution("share_a", 1))).toEqual(["拙政园"]);
  });

  it("损坏 JSON → 空记录，不抛错", () => {
    window.localStorage.setItem("tp.execution.v1", "{not json");
    expect(loadExecutionLog()).toEqual({});
  });

  it("形状非法的数据（departedAt 是字符串）→ 整体丢弃", () => {
    window.localStorage.setItem(
      "tp.execution.v1",
      JSON.stringify({ share_a: { "1": { 拙政园: { departedAt: "yesterday" } } } }),
    );
    expect(loadExecutionLog()).toEqual({});
  });

  it("没记录过的行程 → 空对象（UI 显示未打卡，不显示假勾）", () => {
    expect(loadDayExecution("share_unknown", 1)).toEqual({});
    expect(arrivedSpotNames({})).toEqual([]);
  });
});
