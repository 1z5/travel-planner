import { describe, expect, it } from "vitest";
import { EVENT_NAMES, summarize, newEventId } from "@/lib/metrics";
import type { TripEventRecord } from "@/lib/store/types";

// 指标纯函数：北极星「照着走完」第一次变得可计算。
// 口径见 lib/metrics.ts 的注释——分母只算「行中打开过」的行程，
// 没打开过就不知道有没有照着走，把它算进分母是编数据。

let seq = 0;
function ev(name: string, over: Partial<TripEventRecord> = {}): TripEventRecord {
  seq += 1;
  return { id: `ev_${seq}`, name, createdAt: 1_000_000 + seq, ...over };
}

const SINCE = 1_000_000;

describe("指标：事件名封闭枚举", () => {
  it("枚举包含九类行为事件（含行中打卡/付费意愿/撤销）", () => {
    expect([...EVENT_NAMES].sort()).toEqual([
      "day_modified",
      "plan_created",
      "plan_opened",
      "plan_restored",
      "today_arrived",
      "today_departed",
      "today_opened",
      "trip_cloned",
      "upgrade_intent",
    ]);
  });

  it("未知事件名被丢弃（脏数据不进看板）", () => {
    const s = summarize([ev("bogus_event"), ev("plan_created", { shareId: "s1" })], SINCE);
    expect(s.total).toBe(1);
    expect(s.counts.plan_created).toBe(1);
  });
});

describe("指标：漏斗", () => {
  it("按 trip 去重，给出逐步转化率", () => {
    const s = summarize(
      [
        ev("plan_created", { shareId: "a" }),
        ev("plan_created", { shareId: "b" }),
        ev("plan_created", { shareId: "c" }),
        ev("plan_opened", { shareId: "a" }),
        ev("plan_opened", { shareId: "a" }), // 重复打开只算一次
        ev("plan_opened", { shareId: "b" }),
        ev("today_opened", { shareId: "a" }),
      ],
      SINCE,
    );
    expect(s.funnel.map((f) => f.trips)).toEqual([3, 2, 1]);
    expect(s.funnel[1].conversionFromPrev).toBeCloseTo(2 / 3);
    expect(s.funnel[2].conversionFromPrev).toBeCloseTo(1 / 2);
  });

  it("没有 shareId 的事件不进漏斗（匿名噪声不假装成 trip）", () => {
    const s = summarize([ev("plan_created"), ev("plan_opened")], SINCE);
    expect(s.funnel.every((f) => f.trips === 0)).toBe(true);
  });
});

describe("指标：北极星「照着走完」", () => {
  it("行中打开过且当天没改 = 照着走完", () => {
    const s = summarize(
      [
        ev("plan_created", { shareId: "a" }),
        ev("plan_created", { shareId: "b" }),
        ev("today_opened", { shareId: "a" }),
        ev("today_opened", { shareId: "b" }),
        ev("day_modified", { shareId: "b", day: 2, meta: { op: "swap" } }),
      ],
      SINCE,
    );
    expect(s.northStar.tripsWithToday).toBe(2);
    expect(s.northStar.tripsUnmodified).toBe(1);
    expect(s.northStar.rate).toBeCloseTo(0.5);
  });

  it("没有行中打开 → rate 为 null（不编 0% 也不编 100%）", () => {
    const s = summarize([ev("plan_created", { shareId: "a" })], SINCE);
    expect(s.northStar.rate).toBeNull();
    expect(s.northStar.tripsWithToday).toBe(0);
  });

  it("生成过但没打开 → 不计入分母", () => {
    const s = summarize(
      [
        ev("plan_created", { shareId: "a" }),
        ev("plan_created", { shareId: "b" }),
        ev("today_opened", { shareId: "a" }),
        ev("day_modified", { shareId: "b", day: 1 }), // 没打开过却改了（分享页编辑）
      ],
      SINCE,
    );
    expect(s.northStar.tripsWithToday).toBe(1);
    expect(s.northStar.tripsUnmodified).toBe(1);
  });

  it("北极星强信号：有到达打卡且未修改 → followedRate；无打卡 → null（不硬算 0）", () => {
    const s = summarize(
      [
        ev("today_opened", { shareId: "a" }),
        ev("today_arrived", { shareId: "a", day: 1 }),
        ev("today_opened", { shareId: "b" }),
        ev("day_modified", { shareId: "b", day: 1 }),
      ],
      SINCE,
    );
    expect(s.northStar.tripsFollowed).toBe(1);
    expect(s.northStar.followedRate).toBeCloseTo(0.5);

    const none = summarize([ev("today_opened", { shareId: "a" })], SINCE);
    expect(none.northStar.followedRate).toBeNull();
    expect(none.northStar.tripsFollowed).toBe(0);
  });
});

describe("指标：辅助视图", () => {
  it("改动集中在第几天（按次数倒序）", () => {
    const s = summarize(
      [
        ev("day_modified", { shareId: "a", day: 3 }),
        ev("day_modified", { shareId: "a", day: 1 }),
        ev("day_modified", { shareId: "b", day: 3 }),
      ],
      SINCE,
    );
    expect(s.modifiedByDay[0]).toEqual({ day: 3, count: 2 });
    expect(s.modifiedByDay[1]).toEqual({ day: 1, count: 1 });
  });

  it("Top 目的地按生成数排序", () => {
    const s = summarize(
      [
        ev("plan_created", { shareId: "a", city: "香港" }),
        ev("plan_created", { shareId: "b", city: "苏州" }),
        ev("plan_created", { shareId: "c", city: "苏州" }),
      ],
      SINCE,
    );
    expect(s.topCities[0]).toEqual({ city: "苏州", created: 2 });
  });

  it("事件 id 唯一（同毫秒批量写入不撞主键）", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newEventId()));
    expect(ids.size).toBe(200);
  });
});

describe("指标：付费意愿", () => {
  it("按 tier 聚合，非字符串/空 tier 丢弃", () => {
    const s = summarize(
      [
        ev("upgrade_intent", { meta: { tier: "deep-check" } }),
        ev("upgrade_intent", { meta: { tier: "deep-check" } }),
        ev("upgrade_intent", { meta: { tier: "reminders" } }),
        ev("upgrade_intent", { meta: { tier: 123 } }),
        ev("upgrade_intent", { meta: {} }),
        ev("upgrade_intent"),
      ],
      SINCE,
    );
    expect(s.upgradeIntents).toEqual([
      { tier: "deep-check", count: 2 },
      { tier: "reminders", count: 1 },
    ]);
  });

  it("没有意愿数据 → 空数组（看板显示「暂无」，不编 0）", () => {
    const s = summarize([ev("plan_created", { shareId: "a" })], SINCE);
    expect(s.upgradeIntents).toEqual([]);
  });
});
