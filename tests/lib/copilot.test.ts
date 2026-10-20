import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Plan, PlanInput, PlanSpot } from "@/lib/types";
import type { CopilotMsg } from "@/lib/copilot";

// ============================================================
// 行程管家（Copilot）单测：不依赖真实 LLM。
//
// 只 mock 外部边界：
//   1) planner.client / streamChatRetry —— 模型调用（真调用 20-90s，不可测）
//   2) LlmError 用真实类（错误翻译要按它的 retryable 分支走）
//
// prompt 构造、历史/输入截断、JSON 解析、suggestion 的 day/枚举/意图校验、
// 内容层重试、错误类型全部走真实代码。
// ============================================================

const mockStream = vi.hoisted(() => vi.fn());
const mockClient = vi.hoisted(() => vi.fn(() => ({ __fakeLlm: true })));

vi.mock("@/lib/planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/planner")>();
  return {
    ...actual,
    client: mockClient,
    streamChatRetry: (...args: Parameters<typeof actual.streamChatRetry>) => mockStream(...args),
  };
});

const { answerCopilot, buildCopilotMessages, CopilotError } = await import("@/lib/copilot");
const { LlmError } = await import("@/lib/planner");

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
    summary: "园林与水乡三天",
    startDate: "2026-10-10",
    endDate: "2026-10-12",
    startAt: "2026-10-10T10:00",
    endAt: "2026-10-12T18:00",
    days: [
      {
        day: 1,
        theme: "园林第一天",
        spots: [
          mkSpot({
            name: "拙政园",
            time: "09:00-11:30",
            area: "姑苏区",
            costCny: 90,
            poi: {
              rating: 4.8,
              openTime: "09:00-17:00",
              openTime2: "最晚 16:30 入园",
              tel: "0512-67510286",
            },
          }),
          mkSpot({
            name: "姑苏面馆",
            type: "food",
            period: "lunch",
            time: "11:45-12:45",
            costCny: 35,
          }),
        ],
        transitMin: 12,
        legs: [
          {
            from: "拙政园",
            to: "姑苏面馆",
            mode: "walking",
            distanceM: 850,
            durationSec: 660,
            steps: ["沿东北街步行", "进入平江路"],
          },
        ],
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
    totalCostCny: 345,
    budgetCny: 3000,
    tips: ["提前预约苏州博物馆"],
    warnings: ["第 2 天（2026-10-11）白天预报「小雨」，当天有 1 个室外景点（天平山）。"],
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

const ask = (content: string): CopilotMsg[] => [{ role: "user", content }];

const reply = (answer: string, suggestion: unknown = null): string =>
  JSON.stringify({ answer, suggestion });

const systemOfCall = (i: number) => mockStream.mock.calls[i][1] as string;
const userOfCall = (i: number) => mockStream.mock.calls[i][2] as string;
const tagOfCall = (i: number) => mockStream.mock.calls[i][4] as string;

beforeEach(() => {
  mockStream.mockReset();
  mockClient.mockReset().mockReturnValue({ __fakeLlm: true } as never);
});

// ============================================================
// buildCopilotMessages
// ============================================================

describe("buildCopilotMessages", () => {
  it("system 同时带「只基于事实/不编造」准则与完整行程事实（日期/时间轴/真实路段/预算/预警/提示/硬约束/POI）", () => {
    const [systemMsg] = buildCopilotMessages(makePlan(), makeInput(), ask("这条路走得通吗"));
    expect(systemMsg.role).toBe("system");
    const system = systemMsg.content;

    // 桩 LLM 靠这四个字识别行程管家请求，不能删
    expect(system).toContain("行程管家");
    // 准则
    expect(system).toContain("只基于下方【行程事实】");
    expect(system).toContain("严禁编造");
    expect(system).toContain("拿不准就明确说不知道");
    expect(system).toContain("与本次行程无关");
    expect(system).toContain("只给一个最具体");
    // 事实：日期、每日时间轴、真实路段
    expect(system).toContain("2026-10-10");
    expect(system).toContain("第 1 天");
    expect(system).toContain("拙政园");
    expect(system).toContain("09:00-11:30");
    expect(system).toContain(
      "路段：拙政园→姑苏面馆 步行 约850m 约11分钟（沿东北街步行；进入平江路）",
    );
    // POI 事实（高德回填）
    expect(system).toContain("评分4.8");
    expect(system).toContain("营业时间09:00-17:00");
    expect(system).toContain("营业补充最晚 16:30 入园");
    // 预算与使用率
    expect(system).toContain("人均花费");
    expect(system).toContain("预算 ¥3000");
    expect(system).toContain("使用率");
    // warnings / tips
    expect(system).toContain("预报「小雨」");
    expect(system).toContain("提前预约苏州博物馆");
    // 用户硬约束：住所 + 必游地（来自 PlanInput，与生成路径同源）
    expect(system).toContain("全季酒店(观前街店)");
    expect(system).toContain("期望必游地");
    expect(system).toContain("拙政园");
  });

  it("最多只带最近 8 条历史，更早的消息不进 prompt", () => {
    const history: CopilotMsg[] = Array.from({ length: 10 }, (_, i) => ({
      // 最后一条按路由契约必须是 user
      role: i === 9 || i % 2 === 0 ? "user" : "assistant",
      content: `消息-${i}`,
    }));
    const messages = buildCopilotMessages(makePlan(), makeInput(), history);

    // system + 8 条历史
    expect(messages).toHaveLength(9);
    const contents = messages.slice(1).map((m) => m.content);
    expect(contents).not.toContain("消息-0");
    expect(contents).not.toContain("消息-1");
    expect(contents).toContain("消息-2");
    expect(contents).toContain("消息-9");
    expect(messages[0].role).toBe("system");
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("单条用户输入截断到 500 字（assistant 历史不受此限）", () => {
    const messages = buildCopilotMessages(makePlan(), makeInput(), [
      { role: "user", content: "雨".repeat(600) },
    ]);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("user");
    expect([...last.content]).toHaveLength(500);
  });

  it("旧版 job 链接（input=null）：明确标注约束未知，不猜测住所/必游地", () => {
    const system = buildCopilotMessages(makePlan(), null, ask("预算还剩多少"))[0].content;
    expect(system).toContain("旧版分享链接");
    expect(system).toContain("没有保存用户原始输入");
    expect(system).toContain("不要猜测这些约束");
    // 没有 input 时不得凭空出现 input 里的住所
    expect(system).not.toContain("全季酒店(观前街店)");
  });
});

// ============================================================
// answerCopilot
// ============================================================

describe("answerCopilot", () => {
  it("合法的 rain 建议保留；复用 client/streamChatRetry，tag 与 system 标记正确", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("明天有雨，建议把拙政园换成同区域的室内景点。", {
        kind: "fix",
        fixKind: "rain",
        day: 1,
        label: "改室内",
      }),
      tokens: 42,
    });

    const result = await answerCopilot(makePlan(), makeInput(), ask("明天下雨，室外行程怎么办？"));

    expect(result.answer).toContain("室内");
    expect(result.suggestion).toEqual({
      kind: "fix",
      fixKind: "rain",
      day: 1,
      label: "改室内",
    });
    expect(result.usage).toBe(42);
    expect(mockStream).toHaveBeenCalledTimes(1);
    expect(mockClient).toHaveBeenCalledTimes(1);
    expect(tagOfCall(0)).toBe("行程管家");
    expect(systemOfCall(0)).toContain("行程管家");
    // 历史与本次问题分段渲染（桩 LLM 也按这个标记取最后一条 user 消息）
    expect(userOfCall(0)).toContain("【对话历史】");
    expect(userOfCall(0)).toContain("【用户本次问题】");
    expect(userOfCall(0)).toContain("明天下雨，室外行程怎么办？");
  });

  it("suggestion 指向不存在的 day → 丢弃建议，回答照常返回（不重试）", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("明天有雨，建议改室内。", {
        kind: "fix",
        fixKind: "rain",
        day: 9,
        label: "改室内",
      }),
      tokens: 10,
    });

    const result = await answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办"));

    expect(result.answer).toBe("明天有雨，建议改室内。");
    expect(result.suggestion).toBeUndefined();
    // 建议不合规不等于整条回答失败：绝不因此重试/报错
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("fixKind 不在枚举内 → 丢弃建议（回答保留）", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("建议改一下。", {
        kind: "fix",
        fixKind: "teleport",
        day: 1,
        label: "瞬移",
      }),
      tokens: 10,
    });

    const result = await answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办"));
    expect(result.answer).toBe("建议改一下。");
    expect(result.suggestion).toBeUndefined();
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("问天气却给 retime → 意图不匹配丢弃；问时间赶不赶给 retime → 保留", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("下雨就顺延一下。", { kind: "retime", day: 1, label: "顺延第1天" }),
      tokens: 5,
    });
    const weather = await answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办"));
    expect(weather.suggestion).toBeUndefined();

    mockStream.mockResolvedValueOnce({
      content: reply("第 2 天有点赶，可以顺延时间轴。", {
        kind: "retime",
        day: 2,
        label: "顺延第2天",
      }),
      tokens: 7,
    });
    const time = await answerCopilot(
      makePlan(),
      makeInput(),
      ask("第 2 天时间赶不赶？来得及吗"),
    );
    expect(time.suggestion).toEqual({ kind: "retime", day: 2, label: "顺延第2天" });
  });

  it("预算问句匹配 budget-over；与修改无关的信息问题丢弃任何建议", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("把第 2 天人均花费压到 75%。", {
        kind: "fix",
        fixKind: "budget-over",
        day: 2,
        label: "压预算",
      }),
      tokens: 8,
    });
    const budget = await answerCopilot(makePlan(), makeInput(), ask("预算超了，怎么压一下"));
    expect(budget.suggestion).toEqual({
      kind: "fix",
      fixKind: "budget-over",
      day: 2,
      label: "压预算",
    });

    // 只是问票价（信息问题），模型却给了「避开闭馆」建议 → 丢弃
    mockStream.mockResolvedValueOnce({
      content: reply("行程里没有记录拙政园的具体门票价格，建议查官方渠道。", {
        kind: "fix",
        fixKind: "hours",
        day: 1,
        label: "避开闭馆",
      }),
      tokens: 8,
    });
    const info = await answerCopilot(makePlan(), makeInput(), ask("拙政园门票多少钱？"));
    expect(info.suggestion).toBeUndefined();
  });

  it("历史里问过雨、当前问预算：意图只看最后一条 user 消息", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("把第 2 天人均花费压到 75%。", {
        kind: "fix",
        fixKind: "budget-over",
        day: 2,
        label: "压预算",
      }),
      tokens: 9,
    });
    const result = await answerCopilot(makePlan(), makeInput(), [
      { role: "user", content: "明天下雨怎么办" },
      { role: "assistant", content: "建议把拙政园换成室内景点。" },
      { role: "user", content: "那预算超了怎么压" },
    ]);
    expect(result.suggestion?.kind).toBe("fix");
    if (result.suggestion?.kind === "fix") {
      expect(result.suggestion.fixKind).toBe("budget-over");
    }
    // 历史确实进了 prompt，但意图判定只取最后一句
    expect(userOfCall(0)).toContain("明天下雨怎么办");
    expect(userOfCall(0)).toContain("那预算超了怎么压");
  });

  it("answer 超过 200 字 → 截断到 200 字", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("答".repeat(300)),
      tokens: 12,
    });
    const result = await answerCopilot(makePlan(), makeInput(), ask("帮我总结这份行程"));
    expect([...result.answer]).toHaveLength(200);
  });

  it("label 超过 12 字 → 截断，suggestion 仍保留", async () => {
    mockStream.mockResolvedValueOnce({
      content: reply("明天有雨，建议改室内。", {
        kind: "fix",
        fixKind: "rain",
        day: 1,
        label: "这是一个非常非常长的按钮文案",
      }),
      tokens: 12,
    });
    const result = await answerCopilot(makePlan(), makeInput(), ask("明天天气怎么样"));
    expect(result.suggestion?.label).toBe("这是一个非常非常长的按钮");
    expect([...(result.suggestion?.label ?? "")]).toHaveLength(12);
  });

  it("LLM 垃圾输出 → 带纠正指令重试一次；仍失败抛 CopilotError", async () => {
    mockStream.mockResolvedValue({
      content: "抱歉，我不太明白你的意思。",
      tokens: 5,
    });

    await expect(
      answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办")),
    ).rejects.toBeInstanceOf(CopilotError);
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(userOfCall(0)).not.toContain("【上一次输出不符合要求】");
    expect(userOfCall(1)).toContain("【上一次输出不符合要求】");
    expect(userOfCall(1)).toContain("上一次输出不是合法 JSON");
  });

  it("第一次返回空、第二次合法 → 重试成功（纠正指令写清「返回为空」）", async () => {
    mockStream
      .mockResolvedValueOnce({ content: "", tokens: 3 })
      .mockResolvedValueOnce({
        content: reply("明天有雨，建议改室内。", {
          kind: "fix",
          fixKind: "rain",
          day: 1,
          label: "改室内",
        }),
        tokens: 4,
      });

    const result = await answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办"));
    expect(result.answer).toContain("室内");
    expect(result.usage).toBe(7); // 两次调用的 token 累计（成本可见）
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(userOfCall(1)).toContain("上一次返回为空");
  });

  it("两次都缺 answer 字段 → CopilotError（可行动文案），不返回半成品", async () => {
    mockStream.mockResolvedValue({
      content: JSON.stringify({ suggestion: { kind: "retime", day: 1, label: "顺延第1天" } }),
      tokens: 6,
    });
    await expect(
      answerCopilot(makePlan(), makeInput(), ask("时间来得及吗")),
    ).rejects.toThrow(/连续两次返回的结果无法解析/);
    expect(mockStream).toHaveBeenCalledTimes(2);
  });

  it("模型调用失败（LlmError）→ 翻译成 CopilotError，文案可行动", async () => {
    mockStream.mockRejectedValue(new LlmError("生成连接被中断", true));
    await expect(
      answerCopilot(makePlan(), makeInput(), ask("明天下雨怎么办")),
    ).rejects.toThrow(/连接中断/);
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  it("空历史 / 最后一条不是 user → CopilotError 且不调用模型", async () => {
    await expect(answerCopilot(makePlan(), makeInput(), [])).rejects.toBeInstanceOf(CopilotError);
    await expect(
      answerCopilot(makePlan(), makeInput(), [{ role: "assistant", content: "你好" }]),
    ).rejects.toBeInstanceOf(CopilotError);
    expect(mockStream).not.toHaveBeenCalled();
    expect(mockClient).not.toHaveBeenCalled();
  });
});
