import { describe, expect, it } from "vitest";
import {
  RetimeUnavailableError,
  checkDaySchedule,
  isHoursWarning,
  isScheduleWarning,
  parseTimeRange,
  retimeDay,
} from "@/lib/schedule";
import type { Plan, PlanDay, PlanInput, PlanLeg, PlanSpot } from "@/lib/types";

// ============================================================
// 时间轴可执行性单测：不碰网络/存储，全部是纯函数。
// 关键契约（与 e2e / 前端联动）：
// - checkDaySchedule 只在「相邻点对 + 有真实 leg」时判定；
// - retimeDay 只改 time，且对结果再调用一次必须 changed=false（幂等）；
// - 固定时间活动锚点、24:00 溢出的行为钉死；
// - 缺数据（无 legs / 无 startDate）必须显式报错，不能假装顺延成功。
// ============================================================

function mkSpot(over: Partial<PlanSpot> & { name: string }): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: "sight",
    area: "姑苏区",
    durationMin: 60,
    costCny: 50,
    reason: "测试用行程点",
    ...over,
  };
}

function mkLeg(from: string, to: string, minutes: number, mode: PlanLeg["mode"] = "driving"): PlanLeg {
  return {
    from,
    to,
    mode,
    distanceM: 1000,
    durationSec: Math.round(minutes * 60),
    steps: ["测试路段"],
  };
}

function mkDay(spots: PlanSpot[], legs?: PlanLeg[]): PlanDay {
  return {
    day: 1,
    theme: "测试日",
    spots,
    transitMin: 0,
    dailyCostCny: spots.reduce((s, x) => s + x.costCny, 0),
    ...(legs ? { legs } : {}),
  };
}

function mkPlan(day: PlanDay, over: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-12T18:00",
    summary: "测试行程",
    days: [day],
    totalCostCny: 0,
    tips: [],
    warnings: [],
    verified: true,
    ...over,
  };
}

function mkInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "苏州",
    days: 1,
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-10T18:00",
    budget: 1000,
    preferences: [],
    events: [],
    transportMode: "driving",
    ...over,
  };
}

// ---------- parseTimeRange ----------

describe("parseTimeRange 时间区间解析", () => {
  it("正常区间 → 当天分钟数", () => {
    expect(parseTimeRange("09:00-11:30")).toEqual({ start: 540, end: 690 });
    expect(parseTimeRange("00:00-00:01")).toEqual({ start: 0, end: 1 });
    expect(parseTimeRange("23:00-23:59")).toEqual({ start: 1380, end: 1439 });
  });

  it("容忍一位数小时与分隔符两侧空格（模型偶尔这么写）", () => {
    expect(parseTimeRange("9:30-11:00")).toEqual({ start: 570, end: 660 });
    expect(parseTimeRange("09:30 - 11:00")).toEqual({ start: 570, end: 660 });
  });

  it("畸形输入返回 null（不猜）", () => {
    expect(parseTimeRange("")).toBeNull();
    expect(parseTimeRange("09:00")).toBeNull();
    expect(parseTimeRange("上午九点-十一点")).toBeNull();
    expect(parseTimeRange("09:00~11:00")).toBeNull();
    expect(parseTimeRange("9:00")).toBeNull();
    // 分/时越界：24:00 不能当成 1440 漏过去
    expect(parseTimeRange("25:00-26:00")).toBeNull();
    expect(parseTimeRange("09:60-11:00")).toBeNull();
    expect(parseTimeRange("09:00-24:00")).toBeNull();
  });

  it("跨零点 / 零长 / 反向区间返回 null（没有合法的同日区间可推）", () => {
    expect(parseTimeRange("23:00-01:00")).toBeNull();
    expect(parseTimeRange("10:00-10:00")).toBeNull();
    expect(parseTimeRange("11:00-10:00")).toBeNull();
  });
});

// ---------- checkDaySchedule ----------

describe("checkDaySchedule 时间接不上判定", () => {
  const spots = () => [
    mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
    mkSpot({ name: "面馆", time: "10:15-11:15" }),
  ];

  it("有冲突：间距 15 分钟 < 实际需要 22 分钟", () => {
    const day = mkDay(spots(), [mkLeg("拙政园", "面馆", 22)]);
    const conflicts = checkDaySchedule(day);
    expect(conflicts).toEqual([
      {
        from: "拙政园",
        to: "面馆",
        gapMin: 15,
        needMin: 22,
        fromEnd: "10:00",
        toStart: "10:15",
        mode: "driving",
      },
    ]);
  });

  it("无冲突：间距恰好等于所需（22 分钟）不报", () => {
    const day = mkDay(
      [mkSpot({ name: "A", time: "08:00-10:00" }), mkSpot({ name: "B", time: "10:22-11:00" })],
      [mkLeg("A", "B", 22)],
    );
    expect(checkDaySchedule(day)).toEqual([]);
  });

  it("时间重叠（gap 为负）也要报，并保留负值", () => {
    const day = mkDay(
      [mkSpot({ name: "A", time: "08:00-10:00" }), mkSpot({ name: "B", time: "09:50-11:00" })],
      [mkLeg("A", "B", 22)],
    );
    const [c] = checkDaySchedule(day);
    expect(c.gapMin).toBe(-10);
    expect(c.needMin).toBe(22);
  });

  it("needMin 向上取整：22 分 1 秒按 23 分钟要求", () => {
    const leg = { ...mkLeg("A", "B", 22), durationSec: 1321 };
    const day = mkDay(
      [mkSpot({ name: "A", time: "08:00-10:00" }), mkSpot({ name: "B", time: "10:22-11:00" })],
      [leg],
    );
    const [c] = checkDaySchedule(day);
    expect(c.needMin).toBe(23);
    expect(c.gapMin).toBe(22);
  });

  it("缺 legs → 返回 []（没有真实路段就不判定，不假装通过）", () => {
    expect(checkDaySchedule(mkDay(spots()))).toEqual([]);
    expect(checkDaySchedule(mkDay(spots(), []))).toEqual([]);
  });

  it("只检查相邻且有对应 leg 的点对：中间缺一段时其余段照常判", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00" }),
        mkSpot({ name: "B", time: "10:15-11:15" }),
        mkSpot({ name: "C", time: "11:30-12:30" }),
      ],
      // 只有 A→B 有 leg，B→C 缺（B 没验真到坐标）
      [mkLeg("A", "B", 22)],
    );
    const conflicts = checkDaySchedule(day);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ from: "A", to: "B" });
  });

  it("leg 的 from/to 必须名称严格对上；legs 数组顺序不影响匹配", () => {
    const day = mkDay(
      [mkSpot({ name: "A", time: "08:00-10:00" }), mkSpot({ name: "B", time: "10:15-11:15" })],
      // 故意放一条不匹配的 leg（旧数据/别的天残留），不能拿来判定
      [mkLeg("X", "Y", 30), mkLeg("A", "B", 22)],
    );
    expect(checkDaySchedule(day)).toHaveLength(1);
  });

  it("时间解析不了或 leg.durationSec 非法 → 跳过该对，不误报成「接不上」", () => {
    const badTime = mkDay(
      [mkSpot({ name: "A", time: "上午" }), mkSpot({ name: "B", time: "10:15-11:15" })],
      [mkLeg("A", "B", 22)],
    );
    expect(checkDaySchedule(badTime)).toEqual([]);
    const badLeg = mkDay(
      [mkSpot({ name: "A", time: "08:00-10:00" }), mkSpot({ name: "B", time: "10:15-11:15" })],
      [{ ...mkLeg("A", "B", 22), durationSec: Number.NaN }],
    );
    expect(checkDaySchedule(badLeg)).toEqual([]);
  });

  it("多点时按顺序返回全部冲突（供「每天汇总一条」统计 K）", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00" }),
        mkSpot({ name: "B", time: "10:05-11:00" }),
        mkSpot({ name: "C", time: "11:05-12:00" }),
      ],
      [mkLeg("A", "B", 22), mkLeg("B", "C", 22)],
    );
    expect(checkDaySchedule(day).map((c) => `${c.from}→${c.to}`)).toEqual(["A→B", "B→C"]);
  });
});

// ---------- retimeDay ----------

describe("retimeDay 确定性顺延", () => {
  function conflictDay(): PlanDay {
    return mkDay(
      [
        mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "面馆", time: "10:15-11:15", durationMin: 60 }),
        mkSpot({ name: "博物馆", time: "11:30-12:50", durationMin: 80 }),
      ],
      [mkLeg("拙政园", "面馆", 22), mkLeg("面馆", "博物馆", 22)],
    );
  }

  it("修好冲突：顺延后每段时间都接得上", () => {
    const plan = mkPlan(conflictDay());
    expect(checkDaySchedule(plan.days[0])).toHaveLength(2);

    const r = retimeDay(plan, mkInput(), 1);
    expect(r.changed).toBe(true);
    expect(checkDaySchedule(r.day)).toEqual([]);
    // 首点保持原开始时间；后续 = 上一点结束 + leg 分钟数
    expect(r.day.spots.map((s) => s.time)).toEqual([
      "08:00-10:00",
      "10:22-11:22",
      "11:44-13:04",
    ]);
  });

  it("保留每个点的 durationMin（time 长度必须等于停留时长）", () => {
    const r = retimeDay(mkPlan(conflictDay()), mkInput(), 1);
    for (const spot of r.day.spots) {
      const range = parseTimeRange(spot.time)!;
      expect(range.end - range.start).toBe(spot.durationMin);
    }
  });

  it("幂等：对顺延结果再调用一次必须 changed=false 且时间逐字符相同", () => {
    const first = retimeDay(mkPlan(conflictDay()), mkInput(), 1);
    const second = retimeDay(mkPlan(first.day), mkInput(), 1);
    expect(second.changed).toBe(false);
    expect(second.day.spots.map((s) => s.time)).toEqual(first.day.spots.map((s) => s.time));
  });

  it("不修改入参 plan（纯函数）：原 day 的时间保持原样", () => {
    const plan = mkPlan(conflictDay());
    const before = plan.days[0].spots.map((s) => s.time);
    retimeDay(plan, mkInput(), 1);
    expect(plan.days[0].spots.map((s) => s.time)).toEqual(before);
  });

  it("固定时间活动锚点：顺延结果晚于活动时，保留锚点并说明原因", () => {
    const day: PlanDay = {
      ...mkDay(
        [
          mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
          mkSpot({ name: "周杰伦演唱会", time: "12:00-13:00", durationMin: 60, type: "activity" }),
          mkSpot({ name: "夜宵", time: "14:00-15:00", durationMin: 60, type: "food" }),
        ],
        [mkLeg("拙政园", "周杰伦演唱会", 20), mkLeg("周杰伦演唱会", "夜宵", 20)],
      ),
    };
    const plan = mkPlan(day);
    const input = mkInput({
      events: [{ name: "演唱会", date: "2026-10-10", time: "09:30" }],
    });
    const r = retimeDay(plan, input, 1);
    expect(r.day.spots[1].time).toBe("09:30-10:30");
    expect(r.notes).toContain("「周杰伦演唱会」是固定时间活动，已按它的时间排");
    // 从锚点继续：夜宵 = 10:30 + 20 分钟路 = 10:50
    expect(r.day.spots[2].time).toBe("10:50-11:50");
  });

  it("锚点比顺延结果晚时不冲突：钉在活动时间、不改写活动、不产生冲突说明", () => {
    const day = mkDay(
      [
        mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "周杰伦演唱会", time: "12:00-13:00", durationMin: 60, type: "activity" }),
      ],
      [mkLeg("拙政园", "周杰伦演唱会", 20)],
    );
    const input = mkInput({ events: [{ name: "周杰伦演唱会", date: "2026-10-10", time: "20:00" }] });
    const r = retimeDay(mkPlan(day), input, 1);
    expect(r.day.spots[1].time).toBe("20:00-21:00");
    expect(r.notes.join("")).not.toContain("固定时间活动");
  });

  it("活动落在别的天 → 不拿同名点乱钉（不猜）", () => {
    const day = mkDay(
      [
        mkSpot({ name: "拙政园", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "周杰伦演唱会", time: "11:00-12:00", durationMin: 60, type: "activity" }),
      ],
      [mkLeg("拙政园", "周杰伦演唱会", 20)],
    );
    // 活动日期是 2026-10-11（第 2 天），目标天是第 1 天 → 不应用锚点
    const input = mkInput({ events: [{ name: "周杰伦演唱会", date: "2026-10-11", time: "20:00" }] });
    const r = retimeDay(mkPlan(day), input, 1);
    expect(r.day.spots[1].time).toBe("10:20-11:20");
    expect(r.notes.join("")).not.toContain("固定时间活动");
  });

  it("顺延超过 24:00：不生成非法时间，保留可排前缀并给出减少 1 个点的建议", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "23:00-23:30", durationMin: 30 }),
        mkSpot({ name: "B", time: "23:40-23:55", durationMin: 15 }),
        mkSpot({ name: "C", time: "23:56-23:59", durationMin: 3 }),
      ],
      // A→B 只要 5 分钟 → B 会从 23:40 提前到 23:35（changed）；B→C 10 分钟 →
      // C 的起点会到 23:50+10=24:00（溢出，不再排）
      [mkLeg("A", "B", 5), mkLeg("B", "C", 10)],
    );
    const r = retimeDay(mkPlan(day), mkInput(), 1);
    expect(r.changed).toBe(true);
    expect(r.notes.some((n) => n.includes("顺延后已超出当天 24:00，建议减少 1 个点"))).toBe(true);
    // 每个 time 都是合法 HH:MM-HH:MM（没有 24:xx）
    for (const spot of r.day.spots) {
      expect(parseTimeRange(spot.time)).not.toBeNull();
    }
    // 溢出的 C 保持原样（不编非法时间）
    expect(r.day.spots[2].time).toBe("23:56-23:59");
  });

  it("无 legs（未验真/旧行程）→ 抛 no_route_data（不能假装能顺延）", () => {
    const plan = mkPlan(conflictDay());
    plan.days[0].legs = undefined;
    expect(() => retimeDay(plan, mkInput(), 1)).toThrow(RetimeUnavailableError);
    try {
      retimeDay(plan, mkInput(), 1);
    } catch (e) {
      expect((e as RetimeUnavailableError).code).toBe("no_route_data");
    }
  });

  it("有 legs 但没有任何一段与当天点位匹配 → 同样视为无可用路线", () => {
    const day = { ...conflictDay(), legs: [mkLeg("不存在A", "不存在B", 22)] };
    try {
      retimeDay(mkPlan(day), mkInput(), 1);
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as RetimeUnavailableError).code).toBe("no_route_data");
    }
  });

  it("缺 startDate → 抛 missing_start_date（算不出固定活动哪天）", () => {
    const plan = mkPlan(conflictDay(), { startDate: undefined });
    try {
      retimeDay(plan, mkInput(), 1);
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as RetimeUnavailableError).code).toBe("missing_start_date");
    }
  });

  it("非法 dayNumber → 抛 day_not_found（带可行动信息）", () => {
    try {
      retimeDay(mkPlan(conflictDay()), mkInput(), 9);
      throw new Error("应当抛错");
    } catch (e) {
      expect((e as RetimeUnavailableError).code).toBe("day_not_found");
      expect((e as Error).message).toContain("第 9 天");
    }
  });

  it("当天只有 1 个点 → changed=false + 说明（不是错误）", () => {
    const day = mkDay([mkSpot({ name: "拙政园", time: "08:00-10:00" })]);
    const r = retimeDay(mkPlan(day), mkInput(), 1);
    expect(r.changed).toBe(false);
    expect(r.notes.join("")).toContain("只有 1 个行程点");
  });

  it("首点时间解析不出 → changed=false 并说明，不乱改后面的点", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "上午" }),
        mkSpot({ name: "B", time: "10:15-11:15" }),
      ],
      [mkLeg("A", "B", 22)],
    );
    const r = retimeDay(mkPlan(day), mkInput(), 1);
    expect(r.changed).toBe(false);
    expect(r.notes.join("")).toContain("无法识别");
    expect(r.day.spots.map((s) => s.time)).toEqual(["上午", "10:15-11:15"]);
  });

  it("部分段缺 leg：按 0 分钟衔接但在 notes 里点明缺数据（不假装整链真实）", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "B", time: "10:15-11:15", durationMin: 60 }),
        mkSpot({ name: "C", time: "11:30-12:30", durationMin: 60 }),
      ],
      [mkLeg("A", "B", 22)], // B→C 缺失
    );
    const r = retimeDay(mkPlan(day), mkInput(), 1);
    expect(r.changed).toBe(true);
    expect(r.notes.some((n) => n.includes("缺少真实路段数据"))).toBe(true);
    expect(r.day.spots[2].time).toBe("11:22-12:22"); // B 结束后 +0
  });

  it("只返回目标那一天的 day（其余天不参与）", () => {
    const day1 = conflictDay();
    const day2: PlanDay = { ...mkDay([mkSpot({ name: "D", time: "09:00-10:00" })]), day: 2 };
    const plan = mkPlan(day1);
    plan.days = [day1, day2];
    const r = retimeDay(plan, mkInput(), 1);
    expect(r.day.day).toBe(1);
    expect(r.day.spots).toHaveLength(day1.spots.length);
  });

  it("已经是完美时间轴 → changed=false（无需落库）", () => {
    const day = mkDay(
      [
        mkSpot({ name: "A", time: "08:00-10:00", durationMin: 120 }),
        mkSpot({ name: "B", time: "10:22-11:22", durationMin: 60 }),
      ],
      [mkLeg("A", "B", 22)],
    );
    const r = retimeDay(mkPlan(day), mkInput(), 1);
    expect(r.changed).toBe(false);
    expect(r.notes).toEqual([]);
  });
});

// ---------- 预警分类 ----------

describe("isScheduleWarning / isHoursWarning 标记词判定", () => {
  it("时间轴汇总预警只认「时间接不上」", () => {
    expect(
      isScheduleWarning(
        "第 1 天有 2 段「时间接不上」：如「A」10:00 结束到「B」10:15 开始只有 15 分钟，但驾车约需 22 分钟——可用「一键顺延」重排当天时间轴",
      ),
    ).toBe(true);
    expect(isScheduleWarning("第 1 天安排约 12 小时，超出适中节奏上限（10 小时）")).toBe(false);
  });

  it("营业预警不会被「一键顺延」误归成时间轴（两类文案有交叉标记词）", () => {
    const outside =
      "第 1 天「拙政园」计划 08:00-10:00，但 09:00 才开门（高德：周一至周日 09:00-17:00），可能进不去，建议用「一键顺延」调整时间";
    expect(isScheduleWarning(outside)).toBe(false);
    expect(isHoursWarning(outside)).toBe(true);
  });

  it("闭馆 / 暂停开放 / 营业时间 都归营业类；普通预警两类都不是", () => {
    expect(isHoursWarning("第 3 天「同里古镇」周一闭馆（高德：周一 全天不开放），当天去不了")).toBe(true);
    expect(isHoursWarning("第 1 天「金沙遗址博物馆」在高德显示「暂停开放」，出发前请确认")).toBe(true);
    expect(isHoursWarning("营业时间无法确认，建议现场核实")).toBe(true);
    expect(isHoursWarning("第 1 天安排约 12 小时，超出适中节奏上限（10 小时）")).toBe(false);
    expect(isScheduleWarning("行程合计人均约 3000 元")).toBe(false);
  });
});
