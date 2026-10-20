import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayView } from "@/components/TodayView";
import type { Plan, PlanSpot } from "@/lib/types";

// 控制「今天/现在」：只 mock 两个读时钟的函数，tripToday/spotNow 保持真实
// （它们已被 lib 单测覆盖）——这里测的是「真实行中逻辑 + 可控时钟输入」。
// mockClock 前缀 + vi.hoisted 是 vitest 的要求（vi.mock 会提升到文件顶部）。
const mockClock = vi.hoisted(() => ({ today: "2026-10-18", minutes: 9 * 60 + 30 }));
vi.mock("@/lib/trip-day", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trip-day")>();
  return {
    ...actual,
    localTodayIso: () => mockClock.today,
    nowMinutes: () => mockClock.minutes,
  };
});

const mkSpot = (over: Partial<PlanSpot> & { name: string; time: string }): PlanSpot => ({
  period: "morning",
  type: "sight",
  area: "青羊区",
  durationMin: 90,
  costCny: 60,
  reason: "测试行程点",
  ...over,
});

/**
 * 3 天行程：第 1 天三个点（含 2 段 legs：步行 500 米/7 分钟、驾车 2.2 公里/8 分钟），
 * 第 2/3 天各一个点用于断言「今日视图只渲染今天」。
 */
function basePlan(): Plan {
  return {
    city: "成都",
    startDate: "2026-10-18",
    endDate: "2026-10-20",
    summary: "成都 3 天：老城慢游 → 熊猫基地 → 都江堰。",
    totalCostCny: 1200,
    tips: [],
    warnings: [],
    verified: true,
    days: [
      {
        day: 1,
        theme: "老城慢游",
        transitMin: 30,
        dailyCostCny: 260,
        spots: [
          mkSpot({
            name: "宽窄巷子",
            time: "08:00-10:00",
            durationMin: 120,
            costCny: 50,
            rainBackup: "成都博物馆（室内）",
            location: "104.055,30.665",
          }),
          mkSpot({ name: "陈麻婆豆腐", time: "10:30-12:00", type: "food", costCny: 80 }),
          mkSpot({
            name: "人民公园",
            time: "12:30-14:00",
            type: "activity",
            costCny: 0,
            location: "104.063,30.657",
          }),
        ],
        legs: [
          {
            from: "宽窄巷子",
            to: "陈麻婆豆腐",
            mode: "walking",
            distanceM: 500,
            durationSec: 420,
            steps: ["沿长顺上街向南步行 300 米", "在路口右转再走 200 米"],
          },
          {
            from: "陈麻婆豆腐",
            to: "人民公园",
            mode: "driving",
            distanceM: 2200,
            durationSec: 480,
            steps: [],
          },
        ],
      },
      {
        day: 2,
        theme: "熊猫基地",
        transitMin: 40,
        dailyCostCny: 300,
        spots: [
          mkSpot({
            name: "大熊猫繁育研究基地",
            time: "08:00-12:00",
            durationMin: 240,
            costCny: 55,
            location: "104.145,30.735",
          }),
        ],
      },
      {
        day: 3,
        theme: "都江堰",
        transitMin: 60,
        dailyCostCny: 200,
        spots: [mkSpot({ name: "都江堰景区", time: "09:00-13:00", durationMin: 240, costCny: 80 })],
      },
    ],
  };
}

/** /api/weather 的成功响应（date 用 mockClock.today，保证命中「今天」那份预报） */
function weatherOk(dayWeather = "中雨", nightWeather = "多云") {
  return {
    ok: true,
    json: async () => ({
      state: "ok",
      days: [
        {
          date: mockClock.today,
          dayWeather,
          nightWeather,
          dayTemp: "22",
          nightTemp: "15",
        },
      ],
    }),
  } as unknown as Response;
}

/** 在 TodayView 里，点「查看今天天气」是第一次 fetch；之后才是 refine */
function weatherThen(fix: (url: string, init?: RequestInit) => Promise<unknown> | unknown) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).startsWith("/api/weather")) return weatherOk();
    return (await fix(url, init)) as Response;
  });
}

describe("TodayView 三态（出发前 / 旅行中 / 已结束）", () => {
  beforeEach(() => {
    mockClock.today = "2026-10-18";
    mockClock.minutes = 9 * 60 + 30;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("出发前 → 「还有 N 天出发」+ 第一天预览，不渲染今日时间轴", async () => {
    const plan = { ...basePlan(), startDate: "2026-11-01", endDate: "2026-11-03" };
    render(<TodayView plan={plan} shareId="share_test123" />);
    // 10-18 → 11-01 是 14 天
    expect(await screen.findByText(/还有 14 天出发/)).toBeInTheDocument();
    expect(screen.getByText(/第一天预览 · 老城慢游/)).toBeInTheDocument();
    expect(screen.getByText("宽窄巷子")).toBeInTheDocument();
    expect(screen.queryByText("今日时间轴")).not.toBeInTheDocument();
    const full = screen.getByText("查看完整行程").closest("a");
    expect(full).toHaveAttribute("href", "/p/share_test123");
  });

  it("行程已结束 → 明确说「行程已结束」并给出总结数字", async () => {
    const plan = { ...basePlan(), startDate: "2000-01-01", endDate: "2000-01-03" };
    render(<TodayView plan={plan} shareId="share_test123" />);
    expect(await screen.findByText("行程已结束")).toBeInTheDocument();
    expect(screen.getByText(/成都 3 天：/)).toBeInTheDocument();
    expect(screen.getByText(/人均 ¥1,200/)).toBeInTheDocument();
    expect(screen.getByText(/3 天$/)).toBeInTheDocument();
  });

  it("旅行中 → 页头是「城市 · 第 N 天 + 主题 + 今天日期」，且其它天不出现", async () => {
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("成都 · 第 1 天")).toBeInTheDocument();
    expect(screen.getByText(/老城慢游 · 10月18日/)).toBeInTheDocument();
    expect(screen.getByText("今日时间轴")).toBeInTheDocument();
    // 「行中」只渲染今天：第 2/3 天的点不应出现在 DOM 里
    expect(screen.queryByText("大熊猫繁育研究基地")).not.toBeInTheDocument();
    expect(screen.queryByText("都江堰景区")).not.toBeInTheDocument();
  });

  it("异常 plan（无 startDate / days=0）不崩，退化为「判断不了今天是第几天」", async () => {
    const noDate = { ...basePlan(), startDate: undefined, endDate: undefined };
    const { unmount } = render(<TodayView plan={noDate} shareId="share_test123" />);
    expect(await screen.findByText(/判断不了今天是第几天/)).toBeInTheDocument();
    // 不猜「今天」，也就没有今日时间轴
    expect(screen.queryByText("今日时间轴")).not.toBeInTheDocument();
    unmount();

    render(<TodayView plan={{ ...basePlan(), days: [] }} shareId="share_test123" />);
    expect(await screen.findByText(/判断不了今天是第几天/)).toBeInTheDocument();
  });
});

describe("TodayView 现在 / 下一站", () => {
  beforeEach(() => {
    mockClock.today = "2026-10-18";
    mockClock.minutes = 9 * 60 + 30;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("当前落在某点时段 → 状态行「现在：X」+ 该点标「现在」", async () => {
    const { container } = render(<TodayView plan={basePlan()} shareId="share_test123" />);
    // 09:30 落在宽窄巷子 08:00-10:00 内
    expect(await screen.findByText("现在：宽窄巷子")).toBeInTheDocument();
    expect(screen.getByText("现在")).toBeInTheDocument(); // 点位徽章（单词节点）
    expect(container.querySelector(".today-spot-now")).toBeInTheDocument();
    expect(screen.getByText(/08:00-10:00 · 青羊区/)).toBeInTheDocument();
  });

  it("当前落在两站之间的空隙 → 状态行「下一站：X」+ 该点标「下一站」", async () => {
    mockClock.minutes = 10 * 60 + 5; // 10:05：宽窄巷子已结束、陈麻婆豆腐未开始
    const { container } = render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("下一站：陈麻婆豆腐")).toBeInTheDocument();
    expect(screen.getByText("下一站")).toBeInTheDocument();
    expect(container.querySelector(".today-spot-next")).toBeInTheDocument();
  });

  it("今天还没开始 → 明确说「还没开始 + 第一站」，不假装现在在某点", async () => {
    mockClock.minutes = 7 * 60; // 07:00，早于第一站 08:00
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("今天的行程还没开始 · 第一站：宽窄巷子")).toBeInTheDocument();
    expect(screen.queryByText("现在：宽窄巷子")).not.toBeInTheDocument();
  });

  it("今天所有点都结束 → 明确说「今天的行程已结束」", async () => {
    mockClock.minutes = 23 * 60; // 23:00，晚于最后一站 14:00
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("今天的行程已结束")).toBeInTheDocument();
  });
});

describe("TodayView 今日时间轴 / 路段 / 导航 / 花费", () => {
  beforeEach(() => {
    mockClock.today = "2026-10-18";
    mockClock.minutes = 9 * 60 + 30;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("今日时间轴展示时间/类型/停留/花费/雨天备选；今日花费合计来自 dailyCostCny", async () => {
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    expect(screen.getByText("景点")).toBeInTheDocument(); // 类型徽章
    expect(screen.getByText(/停留 120 分钟/)).toBeInTheDocument();
    expect(screen.getByText(/人均 ¥50/)).toBeInTheDocument();
    expect(screen.getByText(/雨天备选：成都博物馆（室内）/)).toBeInTheDocument();
    expect(screen.getByText(/今日人均 ¥260/)).toBeInTheDocument();
  });

  it("有 legs → 渲染「步行 500 米 · 7 分钟」「驾车 2.2 公里 · 8 分钟」+ 可展开分步指令", async () => {
    const { container } = render(<TodayView plan={basePlan()} shareId="share_test123" />);
    expect(await screen.findByText("步行 500 米 · 7 分钟")).toBeInTheDocument();
    expect(screen.getByText("驾车 2.2 公里 · 8 分钟")).toBeInTheDocument();
    // 只有第一段有 steps → 只渲染一个 <details>；分步指令内容在 DOM 里
    const details = container.querySelectorAll("details.today-leg-steps");
    expect(details).toHaveLength(1);
    expect(details[0].querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("沿长顺上街向南步行 300 米")).toBeInTheDocument();
    expect(screen.getByText("分步指令")).toBeInTheDocument();
  });

  it("无 legs（旧行程）→ 不渲染任何路段卡，也不崩", async () => {
    const plan = basePlan();
    delete plan.days[0].legs;
    const { container } = render(<TodayView plan={plan} shareId="share_test123" />);
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    expect(container.querySelector(".today-leg")).not.toBeInTheDocument();
    expect(screen.queryByText("分步指令")).not.toBeInTheDocument();
  });

  it("有坐标的点给「导航到这里」外链（高德 URI，新窗口 + noopener）；无坐标点不给", async () => {
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    // 只有宽窄巷子 + 人民公园有 location
    const links = await screen.findAllByText("导航到这里");
    expect(links).toHaveLength(2);
    const a = links[0].closest("a")!;
    expect(a.getAttribute("href")).toContain("uri.amap.com/navigation");
    expect(a.getAttribute("href")).toContain("104.055,30.665");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
    // 无坐标的点不渲染入口（不给假地址）
    expect(screen.queryByLabelText("导航到陈麻婆豆腐")).not.toBeInTheDocument();
  });

  it("有坐标的点才显示「离我多远」入口；定位成功后按站显示直线距离", async () => {
    // 先断言「没有坐标 → 没有入口」
    const noLocation = basePlan();
    noLocation.days[0].spots = noLocation.days[0].spots.map((s) => ({ ...s, location: undefined }));
    const first = render(<TodayView plan={noLocation} shareId="share_test123" />);
    expect(await screen.findByText("今日时间轴")).toBeInTheDocument();
    expect(screen.queryByText("离我多远")).not.toBeInTheDocument();
    first.unmount();

    // 有坐标 + 定位成功（mock 位置正好在宽窄巷子坐标上）
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) =>
          success({
            coords: { longitude: 104.055, latitude: 30.665 },
          } as unknown as GeolocationPosition),
      },
    });
    const { container } = render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("离我多远"));
    await waitFor(() => expect(container.querySelectorAll(".today-spot-dist")).toHaveLength(2));
    expect(screen.getByText(/离我 0 米/)).toBeInTheDocument();
  });

  it("定位失败 → 明说原因（权限被拒绝），不编距离", async () => {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (_success: PositionCallback, error?: PositionErrorCallback) =>
          error?.({ code: 1 } as GeolocationPositionError),
      },
    });
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("离我多远"));
    expect(await screen.findByText("定位权限被拒绝，可在浏览器设置里开启")).toBeInTheDocument();
  });
});

describe("TodayView 天气与一键改室内", () => {
  beforeEach(() => {
    mockClock.today = "2026-10-18";
    mockClock.minutes = 9 * 60 + 30;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });
  });

  it("坏天气 + 有室外景点 → 显示「把今天改成室内路线」；点击请求 action/fixKind/day 正确，成功后渲染新版本", async () => {
    const updated = basePlan();
    updated.days[0] = {
      ...updated.days[0],
      spots: updated.days[0].spots.map((s) =>
        s.name === "宽窄巷子" ? { ...s, name: "成都博物馆（室内）" } : s,
      ),
    };
    const fetchMock = weatherThen(async () => ({
      ok: true,
      json: async () => ({
        plan: updated,
        revision: 2,
        appliedFix: { fixKind: "rain", instruction: "第1天有雨…" },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    expect(await screen.findByText(/中雨/)).toBeInTheDocument();
    await userEvent.click(screen.getByText("把今天改成室内路线"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan/refine");
    expect(JSON.parse(String(init.body))).toMatchObject({
      shareId: "share_test123",
      action: "fix",
      fixKind: "rain",
      day: 1,
    });
    expect(await screen.findByText("已改为第 2 版")).toBeInTheDocument();
    expect(screen.getByText("成都博物馆（室内）")).toBeInTheDocument();
    // 改成功后按钮收起（避免对同一天反复触发）
    expect(screen.queryByText("把今天改成室内路线")).not.toBeInTheDocument();
  });

  it("改室内请求进行中 → 按钮禁用 + 明说「原行程不受影响」", async () => {
    let resolveFix!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveFix = resolve;
    });
    const fetchMock = weatherThen(() => pending as Promise<Response>);
    vi.stubGlobal("fetch", fetchMock);

    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    await screen.findByText(/中雨/);
    await userEvent.click(screen.getByText("把今天改成室内路线"));

    const btn = screen.getByRole("button", { name: "把今天改成室内路线" });
    await waitFor(() => expect(btn).toBeDisabled());
    expect(screen.getByText(/原行程不受影响/)).toBeInTheDocument();

    // 收尾：让请求成功，避免悬挂的 promise 影响其它用例
    resolveFix({ ok: true, json: async () => ({ plan: basePlan(), revision: 2 }) });
    expect(await screen.findByText("已改为第 2 版")).toBeInTheDocument();
  });

  it("改室内失败 → 展示服务端可行动文案，不显示版本号", async () => {
    const fetchMock = weatherThen(async () => ({
      ok: false,
      json: async () => ({ error: "改行程每小时 20 次，已用完，请稍后再试" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    await screen.findByText(/中雨/);
    await userEvent.click(screen.getByText("把今天改成室内路线"));

    expect(await screen.findByText(/每小时 20 次/)).toBeInTheDocument();
    expect(screen.queryByText(/已改为第/)).not.toBeInTheDocument();
    // 失败后仍保留原行程（宽窄巷子还在），且按钮可重试
    expect(screen.getByText("宽窄巷子")).toBeInTheDocument();
    expect(screen.getByText("把今天改成室内路线")).toBeInTheDocument();
  });

  it("网络异常 → 降级提示「修改未保存」，原行程不变", async () => {
    const fetchMock = weatherThen(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    await screen.findByText(/中雨/);
    await userEvent.click(screen.getByText("把今天改成室内路线"));
    expect(await screen.findByText("网络异常，修改未保存，请重试")).toBeInTheDocument();
    expect(screen.getByText("宽窄巷子")).toBeInTheDocument();
  });

  it("天气查不到 → 明说原因，不编天气、不出现改室内按钮", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ state: "unavailable", reason: "未配置高德 key" }),
      })),
    );
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    expect(await screen.findByText("未配置高德 key")).toBeInTheDocument();
    expect(screen.queryByText("把今天改成室内路线")).not.toBeInTheDocument();
    expect(screen.queryByText(/中雨/)).not.toBeInTheDocument();
  });

  it("好天气 → 给室外景点的正面提示，但不出现「改室内」按钮", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => weatherOk("晴", "晴")),
    );
    render(<TodayView plan={basePlan()} shareId="share_test123" />);
    await userEvent.click(await screen.findByText("查看今天天气"));
    expect(await screen.findByText(/室外景点可放心安排/)).toBeInTheDocument();
    expect(screen.queryByText("把今天改成室内路线")).not.toBeInTheDocument();
  });
});
