import { describe, expect, it } from "vitest";
import { matchSpotName, replanSolve } from "@/lib/replan";
import { checkDaySchedule, parseTimeRange } from "@/lib/schedule";
import type { PlanDay, PlanLeg, PlanSpot, SpotType } from "@/lib/types";

// ============================================================
// 行中重规划求解器单测：不碰网络/存储，全部是纯函数。
// 关键契约（与路由 / e2e 联动）：
// - 确定性：给定输入输出可复现（本文件所有断言都是精确值）；
// - 保留的点时刻连续（相邻间隔 ≥ 路程分钟）——用 checkDaySchedule 反证
//   「不出现时间接不上」，这是求解器的核心承诺；
// - 放弃必须显式列出且 reason 引用真实约束（闭馆时间/路程分钟/锚点时间）；
// - 无 legs → ok:false 诚实降级；营业时间 unknown → 保留不判；
// - 锚点是墙：赶不上的点丢弃、锚点本身钉死在活动时间上。
// ============================================================

function mkSpot(over: Partial<PlanSpot> & { name: string }): PlanSpot {
  return {
    period: "afternoon",
    time: "16:00-17:00",
    type: "sight" as SpotType,
    area: "测试区",
    durationMin: 60,
    costCny: 50,
    reason: "测试用行程点",
    ...over,
  };
}

function mkLeg(from: string, to: string, minutes: number): PlanLeg {
  return {
    from,
    to,
    mode: "driving",
    distanceM: 1000,
    durationSec: Math.round(minutes * 60),
    steps: ["测试路段"],
  };
}

/** 把 kept 结果还原成一天的形状，供 checkDaySchedule 反证时刻连续 */
function syntheticDay(kept: Array<{ spot: PlanSpot; newTime: string }>, legs: PlanLeg[]): PlanDay {
  const keptNames = new Set(kept.map((k) => k.spot.name));
  return {
    day: 1,
    theme: "重排结果",
    spots: kept.map((k) => ({ ...k.spot, time: k.newTime })),
    transitMin: 0,
    dailyCostCny: 0,
    // 只保留「相邻保留点之间」的 legs——被放弃的点不参与行程
    legs: legs.filter((l) => keptNames.has(l.from) && keptNames.has(l.to)),
  };
}

const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

describe("replanSolve · 基本求解", () => {
  it("时间充裕：全部保留，时刻按真实路段顺延", () => {
    const spots = [
      mkSpot({ name: "A", time: "16:00-17:00", durationMin: 60 }),
      mkSpot({ name: "B", time: "17:30-18:30", durationMin: 60 }),
      mkSpot({ name: "C", time: "19:00-20:00", durationMin: 60 }),
    ];
    const legs = [mkLeg("A", "B", 20), mkLeg("B", "C", 20)];
    const r = replanSolve({ nowMin: 15 * 60, spots, legs, from: { name: "上一个点" } });

    expect(r.ok).toBe(true);
    expect(r.dropped).toEqual([]);
    expect(r.kept.map((k) => k.newTime)).toEqual(["15:00-16:00", "16:20-17:20", "17:40-18:40"]);
    // 核心承诺：顺延后的时刻不会「时间接不上」（用同门检测器反证）
    expect(checkDaySchedule(syntheticDay(r.kept, legs))).toEqual([]);
  });

  it("正在进行中的点：首站等它原定结束才排（不可重排的点是既成事实）", () => {
    const spots = [
      mkSpot({ name: "A", time: "16:00-17:00", durationMin: 60 }),
      mkSpot({ name: "B", time: "17:30-18:30", durationMin: 60 }),
    ];
    const legs = [mkLeg("A", "B", 20)];
    // 现在 15:30，你还在「正在吃的店」里，它 16:00 才结束
    const r = replanSolve({
      nowMin: 15 * 60 + 30,
      spots,
      legs,
      from: { name: "正在吃的店", endMin: 16 * 60 },
    });

    expect(r.kept.map((k) => k.newTime)).toEqual(["16:00-17:00", "17:20-18:20"]);
  });

  it("没有剩余点 → ok:true + 良性说明（不是失败）", () => {
    const r = replanSolve({ nowMin: 23 * 60, spots: [], legs: [] });
    expect(r.ok).toBe(true);
    expect(r.kept).toEqual([]);
    expect(r.message).toMatch(/走完|无需重排/);
  });

  it("不知道你现在在哪（无 from）：首站从当前时间直接排起并披露", () => {
    const spots = [mkSpot({ name: "A", time: "16:00-17:00", durationMin: 60 })];
    const r = replanSolve({ nowMin: 9 * 60, spots, legs: [mkLeg("X", "A", 5)] });
    // 首站不猜「从当前位置出发的路程」：直接按当前时间起排，notes 说明
    expect(r.kept[0]?.newTime).toBe("09:00-10:00");
    expect(r.notes.some((n) => n.includes("首站"))).toBe(true);
  });
});

describe("replanSolve · 放弃必须显式且引用真实约束", () => {
  it("营业时间到点关门：丢弃且 reason 引用闭馆时间", () => {
    const spot = mkSpot({
      name: "博物馆",
      durationMin: 60,
      poi: { openTime2: "周一至周日 09:00-17:00" },
    });
    const r = replanSolve({
      nowMin: 17 * 60 + 30,
      spots: [spot],
      legs: [mkLeg("起点", "博物馆", 10)],
      from: { name: "起点" },
      hours: { isoDate: "2026-10-10", byName: { 博物馆: spot.poi } },
    });

    expect(r.ok).toBe(true);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].name).toBe("博物馆");
    // 理由必须来自真实营业数据：点名 17:00 关门
    expect(r.dropped[0].reason).toContain("17:00");
    expect(r.dropped[0].reason).toMatch(/已关门|营业时间/);
  });

  it("当天闭馆：丢弃且 reason 引用闭馆日", () => {
    const spot = mkSpot({
      name: "同里古镇",
      durationMin: 60,
      poi: { openTime2: "周二至周日 08:00-17:00；周一 全天不开放" },
    });
    const r = replanSolve({
      nowMin: 9 * 60,
      spots: [spot],
      legs: [mkLeg("起点", "同里古镇", 10)],
      from: { name: "起点" },
      hours: { isoDate: "2026-10-12", byName: { 同里古镇: spot.poi } }, // 周一
    });

    expect(r.dropped[0]?.reason).toContain("周一");
  });

  it("营业时间读不懂：保留（unknown 不判，与体检同口径）", () => {
    const spot = mkSpot({
      name: "神秘场馆",
      durationMin: 60,
      poi: { openTime: "营业时间以现场公告为准，恕不另行通知" },
    });
    const r = replanSolve({
      nowMin: 9 * 60,
      spots: [spot],
      legs: [mkLeg("起点", "神秘场馆", 10)],
      from: { name: "起点" },
      hours: { isoDate: "2026-10-10", byName: { 神秘场馆: spot.poi } },
    });

    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });

  it("锚点前放不下：丢弃且 reason 引用活动时间与真实路程分钟", () => {
    const spots = [
      mkSpot({ name: "诚品书店", time: "17:00-19:00", durationMin: 150 }),
      mkSpot({ name: "演唱会", time: "19:00-21:30", durationMin: 150, type: "activity" }),
    ];
    const legs = [mkLeg("诚品书店", "演唱会", 40)];
    const r = replanSolve({
      nowMin: 16 * 60,
      spots,
      legs,
      from: { name: "上一个点" },
      anchor: { time: "19:00", name: "演唱会" },
    });

    expect(r.kept.map((k) => k.spot.name)).toEqual(["演唱会"]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].name).toBe("诚品书店");
    // 理由来自真实约束：锚点时间 19:00 + 到场地还要走的 40 分钟
    expect(r.dropped[0].reason).toContain("19:00");
    expect(r.dropped[0].reason).toContain("40 分钟");
  });

  it("丢弃不连坐：一个点闭馆，后面的点继续贪心保留", () => {
    const spots = [
      mkSpot({
        name: "闭馆的点",
        durationMin: 60,
        poi: { openTime2: "周一至周日 09:00-17:00" },
      }),
      mkSpot({ name: "开放的点", durationMin: 60, poi: { openTime2: "周一至周日 00:00-24:00" } }),
    ];
    const r = replanSolve({
      nowMin: 17 * 60 + 40,
      spots,
      legs: [mkLeg("起点", "闭馆的点", 5), mkLeg("起点", "开放的点", 5)],
      from: { name: "起点" },
      hours: {
        isoDate: "2026-10-10",
        byName: { 闭馆的点: spots[0].poi, 开放的点: spots[1].poi },
      },
    });

    expect(r.dropped.map((d) => d.name)).toEqual(["闭馆的点"]);
    // 被放弃的点不影响后续：cursor 没动，开放的点仍按「从起点走 5 分钟」排
    expect(r.kept.map((k) => k.newTime)).toEqual(["17:45-18:45"]);
  });

  it("排过 24:00：丢弃并说明（没有 25:00 这种时刻）", () => {
    const spot = mkSpot({ name: "深夜点", durationMin: 90 });
    const r = replanSolve({
      nowMin: 23 * 60,
      spots: [spot],
      legs: [mkLeg("起点", "深夜点", 5)],
      from: { name: "起点" },
    });
    expect(r.dropped[0]?.reason).toContain("24:00");
  });
});

describe("replanSolve · 锚点是不可移动的墙", () => {
  it("锚点本身钉死在活动时间上；晚于推算也照钉并记 notes", () => {
    const spots = [
      mkSpot({ name: "演唱会", time: "19:00-21:30", durationMin: 90, type: "activity" }),
    ];
    // 被堵在路上：原定 19:30 才脱身，活动 19:00 开始——照钉 19:00，notes 说明
    const r = replanSolve({
      nowMin: 18 * 60 + 30,
      spots,
      legs: [mkLeg("路上", "演唱会", 10)],
      from: { name: "路上", endMin: 19 * 60 + 30 },
      anchor: { time: "19:00", name: "演唱会" },
    });

    expect(r.kept.map((k) => k.newTime)).toEqual(["19:00-20:30"]);
    expect(r.notes.some((n) => n.includes("固定活动"))).toBe(true);
  });

  it("活动已开始：不再当墙（剩下的点排在它之后，而不是被过去的墙挡死）", () => {
    // 现在 19:30：演唱会（19:00-21:30）正在进行——它不在「还没走的点」里
    // （路由会先过滤掉），from 给出「你在演唱会、21:30 散场」
    const spots = [mkSpot({ name: "夜宵", time: "22:00-23:00", durationMin: 60 })];
    const r = replanSolve({
      nowMin: 19 * 60 + 30,
      spots,
      legs: [mkLeg("演唱会", "夜宵", 20)],
      from: { name: "演唱会", endMin: 21 * 60 + 30 },
      anchor: { time: "19:00", name: "演唱会" },
    });

    expect(r.kept.map((k) => k.spot.name)).toEqual(["夜宵"]);
    expect(r.dropped).toEqual([]);
    expect(r.notes.some((n) => n.includes("不再当作墙"))).toBe(true);
  });
});

describe("replanSolve · 诚实降级", () => {
  it("没有真实路段（MOCK/境外/旧行程）→ ok:false + 明确文案", () => {
    const r = replanSolve({
      nowMin: 15 * 60 + 30,
      spots: [mkSpot({ name: "A" }), mkSpot({ name: "B" })],
      legs: [],
    });
    expect(r.ok).toBe(false);
    expect(r.kept).toEqual([]);
    expect(r.message).toContain("缺少真实路程数据");
  });

  it("legs 全是非法时长 → 同样降级（拿不到可信 needMin 就不猜）", () => {
    const bad = { ...mkLeg("A", "B", 20), durationSec: Number.NaN };
    const r = replanSolve({ nowMin: 900, spots: [mkSpot({ name: "A" })], legs: [bad] });
    expect(r.ok).toBe(false);
  });

  it("缺某一段 leg：按 0 分钟衔接并 notes 披露（不假装整条链都是真实通勤）", () => {
    const spots = [
      mkSpot({ name: "A", time: "16:00-17:00", durationMin: 60 }),
      mkSpot({ name: "B", time: "17:30-18:30", durationMin: 60 }),
    ];
    const r = replanSolve({
      nowMin: 9 * 60,
      spots,
      legs: [mkLeg("起点", "A", 10)], // A→B 的 leg 缺失
      from: { name: "起点" },
    });

    expect(r.kept.map((k) => k.newTime)).toEqual(["09:10-10:10", "10:10-11:10"]);
    expect(r.notes.some((n) => n.includes("A → B") && n.includes("真实路段"))).toBe(true);
  });

  it("nowMin 非法：不拿默认时间编，直接降级", () => {
    const r = replanSolve({
      nowMin: Number.NaN,
      spots: [mkSpot({ name: "A" })],
      legs: [mkLeg("X", "A", 5)],
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("当前时间");
  });
});

describe("replanSolve · 时刻连续（求解器的核心承诺）", () => {
  it("保留序列相邻间隔 ≥ 真实路程（用 checkDaySchedule 反证无「时间接不上」）", () => {
    const spots = [
      mkSpot({ name: "A", time: "16:00-17:00", durationMin: 60 }),
      mkSpot({ name: "B", time: "17:30-18:30", durationMin: 60 }),
      mkSpot({ name: "C", time: "19:00-20:00", durationMin: 60 }),
      mkSpot({ name: "D", time: "20:30-21:30", durationMin: 60 }),
    ];
    const legs = [mkLeg("A", "B", 20), mkLeg("B", "C", 22), mkLeg("C", "D", 35)];
    const r = replanSolve({ nowMin: 15 * 60, spots, legs, from: { name: "起点" } });

    expect(r.dropped).toEqual([]);
    expect(checkDaySchedule(syntheticDay(r.kept, legs))).toEqual([]);
    // 逐段核对：间隔恰好等于路程分钟（向上取整口径）
    const times = r.kept.map((k) => k.newTime);
    for (let i = 1; i < times.length; i++) {
      const gap = toMin(times[i].split("-")[0]) - toMin(times[i - 1].split("-")[1]);
      expect(gap).toBe(legs[i - 1].durationSec / 60);
    }
  });
});

describe("matchSpotName", () => {
  it("同名 / 简称↔全称 / 无关名称的匹配与不匹配", () => {
    expect(matchSpotName("苏州博物馆", "苏州博物馆")).toBe(true);
    expect(matchSpotName("蜀风雅韵川剧变脸演出(琴台路店)", "川剧变脸")).toBe(true);
    expect(matchSpotName("拙政园", "狮子林")).toBe(false);
    expect(matchSpotName("", "A")).toBe(false);
  });
});

describe("parseTimeRange（复用 schedule.ts 的同一口径）", () => {
  it("合法区间解析；跨零点/零长/非法返回 null", () => {
    expect(parseTimeRange("09:00-11:30")).toEqual({ start: 540, end: 690 });
    expect(parseTimeRange("23:00-01:00")).toBeNull();
    expect(parseTimeRange("10:00-10:00")).toBeNull();
    expect(parseTimeRange("bad")).toBeNull();
  });
});
