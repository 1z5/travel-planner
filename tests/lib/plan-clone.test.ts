import { describe, expect, it } from "vitest";
import { deriveCloneInput, CloneOverridesSchema } from "@/lib/plan-clone";
import type { Plan, PlanInput } from "@/lib/types";
import type { PlanRecord } from "@/lib/store/types";

// 一键克隆的输入推导（lib/plan-clone.ts）：
// 钉住三条契约——继承什么、覆盖什么、什么时候诚实拒绝。
// 为什么单测而不是只靠 e2e：克隆的红线是「真克隆」（走完整生成管线），
// 本模块是那条红线的第一道闸门（输入对不对），e2e 看不到推导细节；
// 而「复制 JSON 改日期」这种假克隆恰恰会在推导层被悄悄实现，必须有断言盯着。

const BASE_INPUT: PlanInput = {
  city: "苏州",
  days: 3,
  startAt: "2026-10-10T10:00",
  endAt: "2026-10-12T18:00",
  budget: 2500,
  preferences: ["美食", "历史文化"],
  hotel: "全季酒店(观前街店)",
  mustVisit: ["拙政园"],
  pace: "balanced",
  scope: "city",
  transportMode: "walking",
  events: [{ name: "昆曲折子戏", date: "2026-10-11", time: "19:30" }],
};

function makePlan(): Plan {
  return {
    city: "苏州",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    summary: "苏州 3 天",
    days: [
      { day: 1, theme: "古城", spots: [], transitMin: 0, dailyCostCny: 800 },
      { day: 2, theme: "园林", spots: [], transitMin: 0, dailyCostCny: 800 },
      { day: 3, theme: "湖畔", spots: [], transitMin: 0, dailyCostCny: 800 },
    ],
    totalCostCny: 2400,
    budgetCny: 2500,
    tips: [],
    warnings: [],
    verified: true,
  };
}

function makeRecord(overrides: Partial<PlanRecord> = {}): PlanRecord {
  return {
    id: "share_test",
    jobId: "job_test",
    ownerKey: "ip:test",
    plan: makePlan(),
    input: BASE_INPUT,
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("deriveCloneInput · 继承", () => {
  it("无覆盖：原样继承城市/偏好/住所/必游地/节奏/范围/交通方式/活动", () => {
    const result = deriveCloneInput(makeRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.city).toBe("苏州");
    expect(result.input.preferences).toEqual(["美食", "历史文化"]);
    expect(result.input.hotel).toBe("全季酒店(观前街店)");
    expect(result.input.mustVisit).toEqual(["拙政园"]);
    expect(result.input.pace).toBe("balanced");
    expect(result.input.scope).toBe("city");
    expect(result.input.transportMode).toBe("walking");
    expect(result.input.events).toEqual([
      { name: "昆曲折子戏", date: "2026-10-11", time: "19:30" },
    ]);
  });

  it("无覆盖：起止时间与天数沿用原行程（含头含尾 = 3 天）", () => {
    const result = deriveCloneInput(makeRecord());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.startAt).toBe("2026-10-10T10:00");
    expect(result.input.endAt).toBe("2026-10-12T18:00");
    expect(result.input.days).toBe(3);
    expect(result.input.budget).toBe(2500);
  });

  it("原输入缺 pace/scope 等可缺字段时按 schema 默认补齐（不抛错）", () => {
    const minimal: PlanInput = {
      city: "成都",
      days: 2,
      startAt: "2026-10-10T10:00",
      endAt: "2026-10-11T18:00",
      budget: 2000,
      preferences: [],
    };
    const result = deriveCloneInput(makeRecord({ input: minimal }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.pace).toBe("balanced");
    expect(result.input.scope).toBe("city");
    expect(result.input.transportMode).toBe("driving");
    expect(result.input.mustVisit).toEqual([]);
    expect(result.input.events).toEqual([]);
  });

  it("原输入缺起止日期时回退到 plan 的展示日期（补默认时刻）", () => {
    const noDates: PlanInput = { ...BASE_INPUT, startAt: undefined, endAt: undefined };
    const result = deriveCloneInput(makeRecord({ input: noDates }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.startAt).toBe("2026-10-10T10:00");
    expect(result.input.endAt).toBe("2026-10-12T18:00");
    expect(result.input.days).toBe(3);
  });

  it("原输入与 plan 都没有任何日期时诚实报错（不编一个默认日期）", () => {
    const noDates: PlanInput = { ...BASE_INPUT, startAt: undefined, endAt: undefined };
    const plan = makePlan();
    delete plan.startDate;
    delete plan.endDate;
    const result = deriveCloneInput(makeRecord({ input: noDates, plan }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("缺少日期");
  });
});

describe("deriveCloneInput · 覆盖", () => {
  it("startAt/endAt 都覆盖：日期换成新的，days 按新档期重推", () => {
    const result = deriveCloneInput(makeRecord(), {
      startAt: "2026-11-07T10:00",
      endAt: "2026-11-09T18:00",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.startAt).toBe("2026-11-07T10:00");
    expect(result.input.endAt).toBe("2026-11-09T18:00");
    expect(result.input.days).toBe(3);
    // 其余仍是继承值
    expect(result.input.city).toBe("苏州");
    expect(result.input.budget).toBe(2500);
  });

  it("只覆盖出发时间：结束时间同步平移，天数不变（改的是哪天出发）", () => {
    const result = deriveCloneInput(makeRecord(), { startAt: "2026-11-07T10:00" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.startAt).toBe("2026-11-07T10:00");
    expect(result.input.endAt).toBe("2026-11-09T18:00");
    expect(result.input.days).toBe(3);
  });

  it("只覆盖出发时间且往前移：结束时间同样往前平移", () => {
    const result = deriveCloneInput(makeRecord(), { startAt: "2026-10-03T10:00" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.endAt).toBe("2026-10-05T18:00");
    expect(result.input.days).toBe(3);
  });

  it("只覆盖结束时间：出发时间不动，天数随窗口变化", () => {
    const result = deriveCloneInput(makeRecord(), { endAt: "2026-10-11T18:00" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.startAt).toBe("2026-10-10T10:00");
    expect(result.input.endAt).toBe("2026-10-11T18:00");
    expect(result.input.days).toBe(2);
  });

  it("只覆盖预算：日期与其他字段全部保持原样", () => {
    const result = deriveCloneInput(makeRecord(), { budget: 4000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.budget).toBe(4000);
    expect(result.input.startAt).toBe("2026-10-10T10:00");
    expect(result.input.endAt).toBe("2026-10-12T18:00");
  });

  it("只覆盖节奏：pace 换成新值，其余不动", () => {
    const result = deriveCloneInput(makeRecord(), { pace: "packed" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.pace).toBe("packed");
    expect(result.input.budget).toBe(2500);
  });

  it("重点活动日期随档期平移（保留活动与时刻）", () => {
    const result = deriveCloneInput(makeRecord(), {
      startAt: "2026-10-17T10:00",
      endAt: "2026-10-19T18:00",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.events).toEqual([
      { name: "昆曲折子戏", date: "2026-10-18", time: "19:30" },
    ]);
  });

  it("活动日期平移后落在新档期之外：保留活动本身、丢掉过期日期", () => {
    const input: PlanInput = {
      ...BASE_INPUT,
      events: [{ name: "行前导览", date: "2026-10-09" }],
    };
    const result = deriveCloneInput(makeRecord({ input }), {
      startAt: "2026-10-17T10:00",
      endAt: "2026-10-19T18:00",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2026-10-09 + 7 天 = 10-16，早于新档期起点 → 不能留一个不属于本次旅行的日期
    expect(result.input.events).toEqual([{ name: "行前导览" }]);
  });

  it("无日期覆盖时活动日期不平移（delta=0）", () => {
    const result = deriveCloneInput(makeRecord(), { budget: 3000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.events).toEqual([
      { name: "昆曲折子戏", date: "2026-10-11", time: "19:30" },
    ]);
  });
});

describe("deriveCloneInput · 拒绝", () => {
  it("record 为 null（旧 job 链接/不存在）→ 明确错误，不假装能克隆", () => {
    const result = deriveCloneInput(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("不存在");
  });

  it("结束早于开始 → 拒绝（与 /api/plan 同文案）", () => {
    const result = deriveCloneInput(makeRecord(), {
      startAt: "2026-10-10T10:00",
      endAt: "2026-10-08T18:00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("结束时间必须晚于开始时间");
  });

  it("城市行程超过 7 天 → 拒绝（天数上限口径不可绕过）", () => {
    const result = deriveCloneInput(makeRecord(), {
      startAt: "2026-10-10T10:00",
      endAt: "2026-10-18T18:00", // 9 个日历日
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("1-7 天");
  });

  it("区域行程 8 天合法（上限放宽到 10，继承原 scope）", () => {
    const region: PlanInput = { ...BASE_INPUT, scope: "region" };
    const result = deriveCloneInput(makeRecord({ input: region }), {
      startAt: "2026-10-10T10:00",
      endAt: "2026-10-17T18:00", // 8 天
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.days).toBe(8);
    expect(result.input.scope).toBe("region");
  });

  it("区域行程超过 10 天 → 拒绝", () => {
    const region: PlanInput = { ...BASE_INPUT, scope: "region" };
    const result = deriveCloneInput(makeRecord({ input: region }), {
      startAt: "2026-10-10T10:00",
      endAt: "2026-10-21T18:00", // 12 天
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("1-10 天");
  });

  it("原行程输入带非法字符（脏数据）→ 拒绝而不是带病拼进 prompt", () => {
    const dirty: PlanInput = { ...BASE_INPUT, city: "苏州<script>" };
    const result = deriveCloneInput(makeRecord({ input: dirty }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("城市名");
  });

  it("继承的必游地超出数量上限 → 拒绝（白名单对继承字段同样生效）", () => {
    const dirty: PlanInput = {
      ...BASE_INPUT,
      mustVisit: ["拙政园", "狮子林", "留园", "虎丘", "寒山寺", "网师园"],
    };
    const result = deriveCloneInput(makeRecord({ input: dirty }));
    expect(result.ok).toBe(false);
  });

  it("非法日期格式 → 拒绝", () => {
    const result = deriveCloneInput(makeRecord(), {
      startAt: "2026/11/07 10:00",
      endAt: "2026-11-09T18:00",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("起始时间");
  });

  it("覆盖的结束时间格式非法 → 拒绝（不进入日期平移算术）", () => {
    const result = deriveCloneInput(makeRecord(), { endAt: "2026-11-09" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("结束时间");
  });

  it("原行程日期本身坏掉（脏历史记录）→ 诚实拒绝而不是 500", () => {
    const dirty: PlanInput = { ...BASE_INPUT, startAt: "未知", endAt: "未知" };
    const result = deriveCloneInput(makeRecord({ input: dirty }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("日期信息无法识别");
  });
});

describe("CloneOverridesSchema", () => {
  it("合法覆盖项通过", () => {
    const parsed = CloneOverridesSchema.safeParse({
      startAt: "2026-11-07T10:00",
      endAt: "2026-11-09T18:00",
      budget: 4000,
      pace: "relaxed",
    });
    expect(parsed.success).toBe(true);
  });

  it("拒绝未知字段（不能靠覆盖项偷偷改继承字段）", () => {
    const parsed = CloneOverridesSchema.safeParse({ city: "成都" });
    expect(parsed.success).toBe(false);
  });

  it("拒绝非法节奏与过低预算", () => {
    expect(CloneOverridesSchema.safeParse({ pace: "extreme" }).success).toBe(false);
    expect(CloneOverridesSchema.safeParse({ budget: 100 }).success).toBe(false);
  });
});
