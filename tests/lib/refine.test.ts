import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, PlanInput, PlanSpot } from "@/lib/types";

// ============================================================
// 行程微调单测：不依赖真实 LLM / 真实高德。
//
// 只 mock 两个外部边界：
//   1) planner 的 client / streamChatRetry —— 模型调用（真调用要 20-90s，不可测）
//   2) validate 的 validatePlan —— 体检（会打高德），但 nameCovered 必须用真实实现：
//      硬约束「必游地/活动不可删」的判定就靠它，mock 掉等于把被测逻辑一起 mock 了。
//
// 其余（prompt 构造、解析、结构核对、重试、只改目标点）全走真实代码。
// ============================================================

const mockStream = vi.hoisted(() => vi.fn());
const mockClient = vi.hoisted(() => vi.fn(() => ({ __fakeLlm: true })));
const mockValidatePlan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/planner")>();
  return {
    ...actual,
    client: mockClient,
    streamChatRetry: (...args: Parameters<typeof actual.streamChatRetry>) => mockStream(...args),
  };
});

vi.mock("@/lib/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/validate")>();
  return { ...actual, validatePlan: mockValidatePlan };
});

const {
  buildRefinePrompt,
  refinePlan,
  sanitizeInstruction,
  RefineLlmError,
  RefineOutputError,
  RefineRejectedError,
} = await import("@/lib/refine");
const { baseLines, LlmError } = await import("@/lib/planner");

// ---------- fixtures ----------

function mkSpot(over: Partial<PlanSpot> & { name: string }): PlanSpot {
  return {
    period: "morning",
    time: "09:00-11:00",
    type: "sight",
    area: "姑苏区",
    durationMin: 120,
    costCny: 50,
    reason: "测试用行程点",
    rainBackup: "室内备选",
    ...over,
  };
}

function makePlan(): Plan {
  return {
    city: "苏州",
    summary: "测试行程",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-12T18:00",
    days: [
      {
        day: 1,
        theme: "园林第一天",
        spots: [
          mkSpot({ name: "拙政园", costCny: 90 }),
          mkSpot({
            name: "姑苏面馆",
            type: "food",
            period: "lunch",
            time: "11:30-12:30",
            costCny: 35,
          }),
        ],
        transitMin: 10,
        dailyCostCny: 125,
      },
      {
        day: 2,
        theme: "天平山木渎",
        spots: [
          mkSpot({ name: "天平山", area: "吴中区木渎", costCny: 30 }),
          mkSpot({
            name: "木渎面馆",
            type: "food",
            period: "lunch",
            time: "12:00-13:00",
            area: "吴中区木渎",
            costCny: 40,
          }),
        ],
        transitMin: 20,
        dailyCostCny: 70,
      },
      {
        day: 3,
        theme: "同里水乡",
        spots: [mkSpot({ name: "同里古镇", area: "吴江区同里", costCny: 100 })],
        transitMin: 0,
        dailyCostCny: 100,
      },
    ],
    totalCostCny: 0,
    tips: ["提前预约园林"],
    warnings: [
      "第 1 天（2026-10-10）白天预报「小雨」，当天有 1 个室外景点（拙政园）。其中 1 个已备有雨天备选，可直接参考",
      "第 2 天（2026-10-11）白天预报「小雨」，当天有 1 个室外景点（天平山）。",
    ],
    verified: false,
  };
}

function makeInput(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "苏州",
    days: 3,
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-12T18:00",
    budget: 3000,
    preferences: ["园林", "博物馆"],
    pace: "balanced",
    hotel: "全季酒店(观前街店)",
    mustVisit: ["拙政园"],
    events: [],
    ...over,
  };
}

/** 单点替换的模型响应 */
function swapPayload(over: Partial<PlanSpot> = {}): string {
  return JSON.stringify({
    spot: mkSpot({ name: "替换后的新景点", area: "吴中区木渎", costCny: 66, ...over }),
  });
}

/** 单日重排的模型响应：names 依次落成 morning/lunch/afternoon 三个点 */
function dayPayload(day: number, names: string[], theme = "桩数据主题"): string {
  const periods = ["morning", "lunch", "afternoon", "dinner"] as const;
  const types = ["sight", "food", "sight", "food"] as const;
  return JSON.stringify({
    day: {
      day,
      theme,
      spots: names.map((name, i) =>
        mkSpot({
          name,
          period: periods[i] ?? "afternoon",
          type: types[i] ?? "sight",
          time: `${9 + i * 2}:00-${10 + i * 2}:30`,
          costCny: 40 + i,
        }),
      ),
    },
  });
}

const totalOf = (plan: Plan) =>
  plan.days.reduce((sum, d) => sum + d.spots.reduce((s, x) => s + x.costCny, 0), 0);

const systemOfCall = (callIdx: number) => mockStream.mock.calls[callIdx][1] as string;
const userOfCall = (callIdx: number) => mockStream.mock.calls[callIdx][2] as string;

beforeEach(() => {
  mockStream.mockReset();
  mockClient.mockReset().mockReturnValue({ __fakeLlm: true } as never);
  // 体检被 mock：把「重跑体检并采用结果」这个契约缩到最小（真实 validatePlan 的
  // 内部逻辑由 tests/lib/validate.test.ts 覆盖）。这里要验证的是 refine 是否真的
  // 调了体检、以及是否采用了它的输出。
  mockValidatePlan.mockReset().mockImplementation(async (plan: Plan) => {
    plan.totalCostCny = totalOf(plan);
    plan.warnings = ["体检：重新核对完成"];
    plan.verified = false;
    plan.verification = "mock";
    return plan;
  });
});

// ============================================================
// buildRefinePrompt
// ============================================================

describe("buildRefinePrompt", () => {
  it("swap：system 带桩可识别标记 + 任务类型；user 含基础约束/目标点/只改一处声明", () => {
    const plan = makePlan();
    const { system, user } = buildRefinePrompt(makeInput(), plan, {
      kind: "swap",
      day: 2,
      spotIndex: 0,
    });

    // 桩 LLM 靠这两个标记分流：不能删/不能改格式
    expect(system).toContain("行程微调");
    expect(system).toContain("【任务类型】单点替换");
    expect(system).toContain("只输出一个合法 JSON 对象");
    expect(system).toContain('{"spot"');

    // 约束与生成路径同源：直接复用 planner 的 baseLines，逐行都在
    for (const line of baseLines(makeInput())) {
      expect(user).toContain(line);
    }
    expect(user).toContain("其他天一行都不许动");
    expect(user).toContain("第 2 天：天平山木渎");
    // 被替换点的上下文（类型/时段/区域/名称）必须在 prompt 里
    expect(user).toContain("【被替换点】序号 1");
    expect(user).toContain("类型 sight");
    expect(user).toContain("时段 morning");
    expect(user).toContain("区域 吴中区木渎");
    expect(user).toContain("名称 天平山");
    // 类型/时段延续 + 避开当天其他点
    expect(user).toContain("新点的 type 必须仍是 sight");
    expect(user).toContain("必须落在同一区域：吴中区木渎");
    expect(user).toContain("木渎面馆");
    expect(user).toContain('只输出 JSON：{"spot"');
  });

  it("day：含用户指令、当天必须保留的硬约束、完整一天输出要求", () => {
    const plan = makePlan();
    const { system, user } = buildRefinePrompt(makeInput(), plan, {
      kind: "day",
      day: 1,
      instruction: "把下午改成室内活动",
    });
    expect(system).toContain("【任务类型】单日重排");
    expect(system).toContain('{"day"');
    expect(user).toContain("【本次任务】单日重排");
    expect(user).toContain("目标：第 1 天");
    expect(user).toContain("【用户指令】「把下午改成室内活动」");
    // 拙政园是 mustVisit 且落在第 1 天 → 必须进「当天必须保留」
    expect(user).toContain("【当天必须保留】拙政园");
    // 完整的「改完后的这一天」，不是增量补丁
    expect(user).toContain("只输出第 1 天改完后的完整一天");
    expect(user).toContain("不得少于 1 个点");
  });

  it("day 无 instruction：明确「未提供指令，按当天主题重排」而不是静默空白", () => {
    const { user } = buildRefinePrompt(makeInput(), makePlan(), { kind: "day", day: 2 });
    expect(user).toContain("未提供：请按当天主题重新安排得更合理");
    expect(user).toContain("当天必须保留】（无）");
  });

  it("纠偏指令出现在重试 prompt 里（且不覆盖正常内容）", () => {
    const { user } = buildRefinePrompt(
      makeInput(),
      makePlan(),
      { kind: "swap", day: 2, spotIndex: 1 },
      "新点类型应为 food，实际 sight",
    );
    expect(user).toContain("【上一次输出不符合要求】新点类型应为 food，实际 sight");
    expect(user).toContain("本次必须修正后重新输出");
    expect(user).toContain("地点");
  });

  it("指令注入防护：引号/反斜杠/花括号/换行/方括号都被清洗掉，不进入 prompt 结构", () => {
    const dirty = '删掉"拙政园"\n{ignore:true}\\ end]';
    const clean = sanitizeInstruction(dirty);
    expect(clean).not.toMatch(/["'`\\{}[\]<>]/);
    expect(clean).not.toContain("\n");
    expect(clean).toBe("删掉拙政园 ignore:true end");

    const { user } = buildRefinePrompt(makeInput(), makePlan(), {
      kind: "day",
      day: 1,
      instruction: dirty,
    });
    // prompt 里出现的是清洗后的指令（被「」包住），结构字符没漏进去
    expect(user).toContain("【用户指令】「删掉拙政园 ignore:true end」");
    expect(user).not.toContain('删掉"拙政园"');
  });

  it("超长指令截断到 100 字（路由上限一致，避免 prompt 被小作文挤爆）", () => {
    const long = "改".repeat(200);
    expect(sanitizeInstruction(long)).toHaveLength(100);
  });
});

// ============================================================
// refinePlan：单点替换
// ============================================================

describe("refinePlan：单点替换", () => {
  it("只替换目标 spot，其他天引用原对象，改完重跑体检", async () => {
    const plan = makePlan();
    const input = makeInput();
    const day2Before = plan.days[1].spots[0];

    mockStream.mockResolvedValueOnce({ content: swapPayload(), tokens: 100 });

    const next = await refinePlan(plan, input, { kind: "swap", day: 2, spotIndex: 0 });

    // 新点替换到位
    expect(next.days[1].spots[0].name).toBe("替换后的新景点");
    expect(next.days[1].spots[0].costCny).toBe(66);
    expect(next.days[1].spots[1].name).toBe("木渎面馆");
    // 其他天内容一字未动（引用原对象，identity 也一致）
    expect(next.days[0]).toBe(plan.days[0]);
    expect(next.days[2]).toBe(plan.days[2]);
    expect(next.days[2].spots[0].name).toBe("同里古镇");
    // 原 plan 的目标天没有被就地改写（失败/并发时用户手里的旧数据仍然自洽）
    expect(day2Before.name).toBe("天平山");
    // 体检被真实调用了，且采用的是体检结果（totalCost 重算）
    expect(mockValidatePlan).toHaveBeenCalledTimes(1);
    expect(next.totalCostCny).toBe(totalOf(next));
    expect(next.totalCostCny).not.toBe(plan.totalCostCny);
    expect(next.warnings).toContain("体检：重新核对完成");
  });

  it("模型先给错类型 → 带纠正指令重试 1 次 → 第二次成功（纠正内容进 prompt）", async () => {
    mockStream
      .mockResolvedValueOnce({ content: swapPayload({ type: "food" }), tokens: 10 })
      .mockResolvedValueOnce({ content: swapPayload(), tokens: 20 });

    const next = await refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 });

    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(userOfCall(0)).not.toContain("【上一次输出不符合要求】");
    expect(userOfCall(1)).toContain("【上一次输出不符合要求】新点类型应为 sight，实际 food");
    expect(next.days[1].spots[0].name).toBe("替换后的新景点");
  });

  it("两次都同名（没真正替换）→ 抛可行动错误，不改动原行程/不落库", async () => {
    mockStream.mockResolvedValue({
      content: JSON.stringify({ spot: mkSpot({ name: "天平山", area: "吴中区木渎" }) }),
      tokens: 1,
    });
    const plan = makePlan();

    await expect(
      refinePlan(plan, makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(RefineOutputError);
    await expect(
      refinePlan(plan, makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(/没有真正替换/);
    expect(mockValidatePlan).not.toHaveBeenCalled();
    expect(plan.days[1].spots[0].name).toBe("天平山");
  });

  it("新点与行程里其他地方重名 → 拒绝（两次后 422）", async () => {
    const dup = JSON.stringify({ spot: mkSpot({ name: "拙政园", area: "吴中区木渎" }) });
    mockStream.mockResolvedValue({ content: dup, tokens: 1 });

    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(/重名/);
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("替换必游地 → 前置拒绝（不调模型、不烧等待时间）", async () => {
    // 第 1 天第 1 个点是 mustVisit「拙政园」
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 1, spotIndex: 0 }),
    ).rejects.toThrow(RefineRejectedError);
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 1, spotIndex: 0 }),
    ).rejects.toThrow(/必游地/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("替换住宿/交通骨架 → 前置拒绝并给出可行动建议", async () => {
    const plan = makePlan();
    plan.days[0].spots.unshift(
      mkSpot({ name: "全季酒店(观前街店)", type: "hotel", period: "evening", costCny: 800 }),
    );

    await expect(
      refinePlan(plan, makeInput(), { kind: "swap", day: 1, spotIndex: 0 }),
    ).rejects.toThrow(/住宿.*硬约束/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("天数/下标越界 → 前置拒绝", async () => {
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 9, spotIndex: 0 }),
    ).rejects.toThrow(/没有第 9 天/);
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 99 }),
    ).rejects.toThrow(/没有第 100 个行程点/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("模型连接中断 → RefineLlmError，且不透出上游原始报错（terminated）", async () => {
    mockStream.mockRejectedValueOnce(new LlmError("生成连接被中断", true));
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(RefineLlmError);
    mockStream.mockRejectedValueOnce(new LlmError("生成连接被中断", true));
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(/连接中断.*稍后重试/);
  });

  it("未配置 LLM_API_KEY → 可行动的服务端配置错误（而不是笼统的「失败」）", async () => {
    mockClient.mockImplementationOnce(() => {
      throw new Error("缺少 LLM_API_KEY，请配置 .env");
    });
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow(/LLM_API_KEY/);
  });
});

// ============================================================
// refinePlan：单日重排
// ============================================================

describe("refinePlan：单日重排", () => {
  it("只替换目标 day、day 编号不变、其他天引用原对象", async () => {
    mockStream.mockResolvedValueOnce({
      content: dayPayload(2, ["新景点A", "新餐厅", "新景点B"]),
      tokens: 50,
    });

    const plan = makePlan();
    const next = await refinePlan(plan, makeInput(), {
      kind: "day",
      day: 2,
      instruction: "第 2 天轻松一点，多留吃饭时间",
    });

    expect(next.days[1].day).toBe(2);
    expect(next.days[1].theme).toBe("桩数据主题");
    expect(next.days[1].spots.map((s) => s.name)).toEqual(["新景点A", "新餐厅", "新景点B"]);
    expect(next.days[0]).toBe(plan.days[0]);
    expect(next.days[2]).toBe(plan.days[2]);
    expect(next.days.length).toBe(3);
    expect(mockValidatePlan).toHaveBeenCalledTimes(1);
  });

  it("空 theme 沿用原主题（不值得为它再烧一次 20-90 秒调用）", async () => {
    mockStream.mockResolvedValueOnce({
      content: dayPayload(2, ["新景点A", "新餐厅"], ""),
      tokens: 50,
    });
    const next = await refinePlan(makePlan(), makeInput(), { kind: "day", day: 2 });
    expect(next.days[1].theme).toBe("天平山木渎");
  });

  it("改掉当天必游地 → 两次后拒绝（422），原行程未被改动", async () => {
    // 第 1 天含 mustVisit 拙政园；两次输出都不含它
    mockStream.mockResolvedValue({ content: dayPayload(1, ["苏州博物馆", "新面馆"]), tokens: 10 });
    const plan = makePlan();

    await expect(refinePlan(plan, makeInput(), { kind: "day", day: 1 })).rejects.toThrow(/拙政园/);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(userOfCall(1)).toContain("【上一次输出不符合要求】");
    expect(userOfCall(1)).toContain("拙政园");
    expect(mockValidatePlan).not.toHaveBeenCalled();
    expect(plan.days[0].spots[0].name).toBe("拙政园");
  });

  it("保住必游地（名称用规范全称/别名）即通过：nameCovered 真实参与判定", async () => {
    // 用户写「拙政园」，模型落成「拙政园（东北街）」这种带后缀的名字也要认
    mockStream.mockResolvedValueOnce({
      content: dayPayload(1, ["拙政园（东北街178号）", "新面馆"]),
      tokens: 10,
    });
    const next = await refinePlan(makePlan(), makeInput(), { kind: "day", day: 1 });
    expect(next.days[0].spots.map((s) => s.name)).toEqual(["拙政园（东北街178号）", "新面馆"]);
  });

  it("重点活动（type=activity）不能被重排掉", async () => {
    const plan = makePlan();
    plan.days[2].spots.push(
      mkSpot({
        name: "测试音乐会",
        type: "activity",
        period: "evening",
        time: "19:00-21:00",
        costCny: 380,
      }),
    );
    mockStream.mockResolvedValue({ content: dayPayload(3, ["同里古镇", "新餐厅"]), tokens: 10 });

    await expect(refinePlan(plan, makeInput(), { kind: "day", day: 3 })).rejects.toThrow(
      /测试音乐会/,
    );
    expect(mockValidatePlan).not.toHaveBeenCalled();
    expect(plan.days[2].spots.map((s) => s.name)).toContain("测试音乐会");
  });

  it("用户指定住所对应的酒店点是硬约束：重排丢掉它 → 拒绝", async () => {
    const plan = makePlan();
    plan.days[1].spots.unshift(
      mkSpot({
        name: "全季酒店(观前街店)",
        type: "hotel",
        period: "evening",
        time: "21:00-21:30",
        costCny: 600,
      }),
    );
    mockStream.mockResolvedValue({ content: dayPayload(2, ["新景点A", "新餐厅"]), tokens: 10 });
    await expect(refinePlan(plan, makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      /全季酒店/,
    );
  });

  it("模型落成的酒店与用户指定住所不一致时，不把它当硬约束（否则这一天永远改不动）", async () => {
    // 真实踩到：生成时模型落成别家酒店（validate 已警告「住所未体现」），
    // 改行程不应该被迫保住那家错酒店
    const plan = makePlan();
    plan.days[1].spots.unshift(
      mkSpot({
        name: "苏州书香府邸·平江府",
        type: "hotel",
        period: "evening",
        time: "21:00-21:30",
        costCny: 800,
      }),
    );
    mockStream.mockResolvedValueOnce({ content: dayPayload(2, ["新景点A", "新餐厅"]), tokens: 10 });
    const next = await refinePlan(plan, makeInput(), { kind: "day", day: 2 });
    expect(next.days[1].spots.map((s) => s.name)).not.toContain("苏州书香府邸·平江府");
  });

  it("返回与原安排完全相同 → 视为没兑现「重排」，重试后报错", async () => {
    const plan = makePlan();
    const same = JSON.stringify({
      day: {
        day: 2,
        theme: "天平山木渎",
        spots: plan.days[1].spots,
      },
    });
    mockStream.mockResolvedValue({ content: same, tokens: 10 });

    await expect(refinePlan(plan, makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      /没有真正重排/,
    );
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("day 字段写错 → 纠正重试；第二次仍错 → 422 且说明原因", async () => {
    mockStream.mockResolvedValue({ content: dayPayload(3, ["新景点A", "新餐厅"]), tokens: 10 });
    await expect(refinePlan(makePlan(), makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      /day 字段应为 2，实际 3/,
    );
    expect(userOfCall(1)).toContain("day 字段应为 2，实际 3");
  });

  it("把一天改成 0 个点 → zod 拦下（不会产出空的一天）", async () => {
    mockStream.mockResolvedValue({
      content: JSON.stringify({ day: { day: 2, theme: "天平山木渎", spots: [] } }),
      tokens: 10,
    });
    await expect(refinePlan(makePlan(), makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      /改行程失败：模型连续两次返回的结果不是要求的 JSON 结构/,
    );
    expect(mockValidatePlan).not.toHaveBeenCalled();
  });

  it("用户指令直接要求删必游地 → 前置拒绝，不调模型", async () => {
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "day", day: 1, instruction: "把拙政园删掉" }),
    ).rejects.toThrow(/必游地/);
    expect(mockStream).not.toHaveBeenCalled();
  });

  it("指令里没点名硬约束的「不要」不算删除硬约束（不能被误拦）", async () => {
    mockStream.mockResolvedValueOnce({ content: dayPayload(2, ["新景点A", "新餐厅"]), tokens: 10 });
    const next = await refinePlan(makePlan(), makeInput(), {
      kind: "day",
      day: 2,
      instruction: "不要去人太多的地方",
    });
    expect(next.days[1].spots.length).toBe(2);
  });

  it("LLM 返回垃圾（非 JSON）→ 两次后 422，纠正指令出现在第二次 prompt", async () => {
    mockStream
      .mockResolvedValueOnce({ content: "抱歉，我不太明白你的意思。", tokens: 5 })
      .mockResolvedValueOnce({ content: "还是不太明白。", tokens: 5 });
    await expect(refinePlan(makePlan(), makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      RefineOutputError,
    );
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(userOfCall(1)).toContain("【上一次输出不符合要求】");
    expect(userOfCall(1)).toContain("不是合法 JSON");
    expect(mockValidatePlan).not.toHaveBeenCalled();
  });

  it("LLM 返回空 → 两次后 422（文案点明「原行程没有被改动」）", async () => {
    mockStream.mockResolvedValue({ content: "   ", tokens: 0 });
    await expect(refinePlan(makePlan(), makeInput(), { kind: "day", day: 2 })).rejects.toThrow(
      /空结果.*原行程没有被改动/,
    );
  });
});

// ============================================================
// 重新体检与天气提示的取舍
// ============================================================

describe("重新体检", () => {
  it("保留未改动天的天气提示、丢弃被改那天的（旧气象描述里的景点可能已被改掉）", async () => {
    mockStream.mockResolvedValueOnce({ content: swapPayload(), tokens: 10 });
    const plan = makePlan();

    const next = await refinePlan(plan, makeInput(), { kind: "swap", day: 2, spotIndex: 0 });

    // 被改第 2 天的天气提示丢弃；第 1 天的保留；非天气预警交给新体检重算（旧的不搬）
    expect(next.warnings).toEqual([
      "体检：重新核对完成",
      "第 1 天（2026-10-10）白天预报「小雨」，当天有 1 个室外景点（拙政园）。其中 1 个已备有雨天备选，可直接参考",
    ]);
  });

  it("不动天气、不做重复 append：连续两次改同一天也只保留一份", async () => {
    const plan = makePlan();
    mockStream.mockResolvedValueOnce({ content: swapPayload(), tokens: 10 }).mockResolvedValueOnce({
      content: swapPayload({ name: "第二个替换点" }),
      tokens: 10,
    });
    const first = await refinePlan(plan, makeInput(), { kind: "swap", day: 2, spotIndex: 0 });
    const second = await refinePlan(first, makeInput(), { kind: "swap", day: 2, spotIndex: 0 });
    expect(second.warnings.filter((w) => w.includes("预报"))).toHaveLength(1);
    expect(new Set(second.warnings).size).toBe(second.warnings.length);
  });

  it("体检抛错时向上冒泡（由路由兜底映射 502），不返回未体检的半成品", async () => {
    mockStream.mockResolvedValueOnce({ content: swapPayload(), tokens: 10 });
    mockValidatePlan.mockRejectedValueOnce(new Error("高德 QPS 超限"));
    await expect(
      refinePlan(makePlan(), makeInput(), { kind: "swap", day: 2, spotIndex: 0 }),
    ).rejects.toThrow("高德 QPS 超限");
  });
});
