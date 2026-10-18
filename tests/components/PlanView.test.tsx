import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "@/components/PlanView";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { localTodayIso } from "@/lib/trip-day";

// 控制「现在」：只 mock 两个读时钟的函数，tripToday/spotNow 保持真实（已被单测
// 覆盖）——测的是真实逻辑 + 可控时钟输入。mockClock 前缀 + vi.hoisted 是 vitest
// 让工厂引用外层变量的规矩（否则 vi.mock 提升到顶部会撞上暂时性死区）。
const mockClock = vi.hoisted(() => ({ today: "2026-10-18", minutes: 9 * 60 + 30 }));
vi.mock("@/lib/trip-day", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/trip-day")>();
  return { ...actual, localTodayIso: () => mockClock.today, nowMinutes: () => mockClock.minutes };
});

// 第一天 spot 时间已知的行程，供「现在/下一站」确定断言
const mkSpot = (name: string, time: string, type: "sight" | "food", location?: string) => ({
  ...SAMPLE_PLAN.days[0].spots[0], name, time, type, ...(location ? { location } : {}),
});
const duringPlan = () => ({
  ...SAMPLE_PLAN,
  startDate: mockClock.today,
  days: [
    { ...SAMPLE_PLAN.days[0], spots: [
      mkSpot("上午景点", "08:00-10:00", "sight"),
      mkSpot("中午餐厅", "10:15-11:15", "food"),
      mkSpot("下午景点", "11:30-12:50", "sight"),
    ] },
    ...SAMPLE_PLAN.days.slice(1),
  ],
});

// 第一天 spot 带坐标的行程，供「定位我在哪」断言距离排序
const duringPlanLocated = () => {
  const base = duringPlan();
  return {
    ...base,
    days: [
      { ...base.days[0], spots: [
        mkSpot("近景点", "08:00-10:00", "sight", "104.07,30.58"),
        mkSpot("远景点", "10:15-11:15", "sight", "104.20,30.80"),
      ] },
      ...base.days.slice(1),
    ],
  };
};

describe("PlanView", () => {
  it("渲染行程头部：城市/天数/总价/验真状态", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getByText(`${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`)).toBeInTheDocument();
    expect(screen.getByText(/人均总花费/)).toBeInTheDocument();
    // MOCK 模式的行程：verified=false → 显示未验真标注
    expect(screen.getByText(/未接高德/)).toBeInTheDocument();
  });

  it("渲染分天卡片与景点明细（时间/名称/区域/花费）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getAllByText("DAY").length).toBe(SAMPLE_PLAN.days.length); // 杂志式日序
    const firstSpot = SAMPLE_PLAN.days[0].spots[0];
    // 名称会同时出现在路线示意图和时间线里，用 getAllByText
    expect(screen.getAllByText(firstSpot.name).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(firstSpot.area)).length).toBeGreaterThan(0);
  });

  it("渲染体检预警区块（含条数）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    if (SAMPLE_PLAN.warnings.length > 0) {
      expect(screen.getByText(new RegExp(`行程体检发现 ${SAMPLE_PLAN.warnings.length} 个问题`))).toBeInTheDocument();
    }
  });

  it("有起止时间时渲染日期行（月日 + 时段）", () => {
    const plan = {
      ...SAMPLE_PLAN,
      startDate: "2026-10-07",
      endDate: "2026-10-10",
      startAt: "2026-10-07T10:00",
      endAt: "2026-10-10T18:00",
    };
    render(<PlanView plan={plan} />);
    expect(screen.getByText(/10月7日 – 10月10日/)).toBeInTheDocument();
    expect(screen.getByText(/10:00 – 18:00/)).toBeInTheDocument();
  });

  it("无起止时间时不渲染日期行（向后兼容）", () => {
    const plan = { ...SAMPLE_PLAN, startDate: undefined, startAt: undefined };
    render(<PlanView plan={plan} />);
    expect(screen.queryByText(/月.*日 –/)).not.toBeInTheDocument();
  });

  it("雨天备选标注渲染", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    const withBackup = SAMPLE_PLAN.days.flatMap((d) => d.spots).find((s) => s.rainBackup);
    if (withBackup) {
      expect(screen.getByText(new RegExp(`雨天备选：${withBackup.rainBackup}`.slice(0, 12)))).toBeInTheDocument();
    }
  });

  it("分享按钮只在提供 shareId 时出现", () => {
    const { rerender } = render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.queryByText("复制分享链接")).not.toBeInTheDocument();
    expect(screen.queryByText(/下载日历/)).not.toBeInTheDocument();

    rerender(<PlanView plan={SAMPLE_PLAN} shareId="job_test123" />);
    expect(screen.getByText("复制分享链接")).toBeInTheDocument();
    expect(screen.getByText("下载日历（.ics）")).toHaveAttribute("href", "/api/plan/ics?id=job_test123");
  });

  it("复制 Markdown 调用剪贴板", async () => {
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<PlanView plan={SAMPLE_PLAN} />);
    await userEvent.click(screen.getByText("复制 Markdown"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(SAMPLE_PLAN.city));
  });

  it("示例横幅（banner）渲染与收起", async () => {
    const onDismiss = vi.fn();
    render(
      <PlanView
        plan={SAMPLE_PLAN}
        banner={
          <div>
            <span>示例横幅</span>
            <button onClick={onDismiss}>收起示例</button>
          </div>
        }
      />,
    );
    expect(screen.getByText("示例横幅")).toBeInTheDocument();
    await userEvent.click(screen.getByText("收起示例"));
    expect(onDismiss).toHaveBeenCalled();
  });
});

// 行中能力：旅行途中打开行程，标出「今天」并显示在行程的哪个位置。
// 组件在 useEffect 里算「今天」（避开 SSR 时区差异），所以用 findBy* 等状态落地。
describe("PlanView 行中高亮（今天）", () => {
  beforeEach(() => {
    mockClock.today = "2026-10-18";
    mockClock.minutes = 9 * 60 + 30; // 09:30，落在上午景点 08:00-10:00 内
    // 定位 mock：getCurrentPosition 直接以固定坐标（成都附近）回调 success
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { longitude: 104.06, latitude: 30.57 } } as unknown as GeolocationPosition),
      },
    });
  });
  afterEach(() => vi.restoreAllMocks()); // 复位各测试里 spy 的 global.fetch 等

  it("无 startDate → 完全不高亮（没有依据就不猜，与天气/活动同一立场）", () => {
    const { container } = render(<PlanView plan={{ ...SAMPLE_PLAN, startDate: undefined }} />);
    expect(screen.queryByText("今天")).not.toBeInTheDocument();
    // 用行中功能专属的 class 断言，避免撞上 SAMPLE_PLAN 预警文案里的「第 N 天」等字样
    expect(container.querySelector(".trip-status")).not.toBeInTheDocument();
    expect(container.querySelector(".today-badge")).not.toBeInTheDocument();
    expect(container.querySelector(".card-today")).not.toBeInTheDocument();
  });

  it("出发前 → 显示「还有 N 天出发」，无「今天」徽章", async () => {
    render(<PlanView plan={{ ...SAMPLE_PLAN, startDate: "2099-01-01" }} />);
    expect(await screen.findByText(/还有 \d+ 天出发/)).toBeInTheDocument();
    expect(screen.queryByText("今天")).not.toBeInTheDocument();
  });

  it("已结束 → 显示「行程已结束」", async () => {
    render(<PlanView plan={{ ...SAMPLE_PLAN, startDate: "2000-01-01" }} />);
    expect(await screen.findByText(/行程已结束/)).toBeInTheDocument();
  });

  it("今天在行程中 → 当天卡片有「今天」徽章 + card-today 高亮 + 「第 N 天」状态行", async () => {
    const today = localTodayIso();
    const { container } = render(<PlanView plan={{ ...SAMPLE_PLAN, startDate: today }} />);
    // 徽章是单个文本节点「今天」，精确匹配不会撞上状态行里的「…今天…」
    expect(await screen.findByText("今天")).toBeInTheDocument();
    // 状态行文本用专属 class 取，避免撞上预警文案里的「第 1 天…」
    const status = container.querySelector(".trip-status-during");
    expect(status).toBeInTheDocument();
    expect(status?.textContent).toMatch(/第 1 天/);
    expect(container.querySelector(".today-badge")).toBeInTheDocument();
    expect(container.querySelector(".card-today")).toBeInTheDocument();
  });

  it("今天在行程中，当前落在某点时段 → 该点标「现在」+ 状态行说现在在哪", async () => {
    mockClock.minutes = 9 * 60 + 30; // 09:30，落在上午景点 08:00-10:00 内
    const { container } = render(<PlanView plan={duringPlan()} />);
    // 徽章是单个文本节点「现在」，精确匹配不撞状态行里的「…现在：X」
    expect(await screen.findByText("现在")).toBeInTheDocument();
    expect(container.querySelector(".spot-now-badge")).toBeInTheDocument();
    expect(container.querySelector(".spot-now")).toBeInTheDocument();
    expect(container.querySelector(".trip-status-during")?.textContent).toMatch(/现在：上午景点/);
  });

  it("当前落在两站之间的空隙 → 下一站标「下一站」+ 状态行说下一站", async () => {
    mockClock.minutes = 10 * 60 + 5; // 10:05，上午景点 10:00 已结束、中午餐厅 10:15 未开始
    const { container } = render(<PlanView plan={duringPlan()} />);
    expect(await screen.findByText("下一站")).toBeInTheDocument();
    expect(container.querySelector(".spot-next-badge")).toBeInTheDocument();
    expect(container.querySelector(".spot-next")).toBeInTheDocument();
    expect(container.querySelector(".trip-status-during")?.textContent).toMatch(/下一站：中午餐厅/);
  });

  it("旅途中点「查看今天天气」→ 展示今天天气 + 坏天气对室外景点的提示", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ state: "ok", days: [
        // 注意：组件消费的是端点响应（fetchWeather 转换后的 camelCase DayWeather），
        // 不是高德原始的小写字段——用错字段名会让展示全空（实测踩过）
        { date: mockClock.today, dayWeather: "小雨", nightWeather: "多云", dayTemp: "24", nightTemp: "18" },
      ] }),
    } as unknown as Response);
    const { container } = render(<PlanView plan={duringPlan()} />);
    await userEvent.click(screen.getByText("查看今天天气"));
    expect(await screen.findByText(/小雨/)).toBeInTheDocument();
    // 天气建议限定在 .weather-warn 里断言——「雨天备选」也会出现在景点卡自带的
    // 「雨天备选：…」标签上，用 getByText 会撞成 multiple elements（实测踩过）
    const warn = container.querySelector(".weather-warn");
    expect(warn?.textContent).toMatch(/个室外景点/);
    expect(warn?.textContent).toMatch(/雨天备选/);
  });

  it("天气查不到 → 降级提示原因，不编造天气", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ state: "unavailable", reason: "未配置高德 key" }),
    } as unknown as Response);
    render(<PlanView plan={duringPlan()} />);
    await userEvent.click(screen.getByText("查看今天天气"));
    expect(await screen.findByText("未配置高德 key")).toBeInTheDocument();
    // 查不到时不展示天气详情（没有「个室外景点」的天气建议）
    expect(screen.queryByText(/个室外景点/)).not.toBeInTheDocument();
  });

  it("定位我在哪 → 按距离列出今天各景点（近→远）", async () => {
    const { container } = render(<PlanView plan={duringPlanLocated()} />);
    await userEvent.click(screen.getByText("定位我在哪"));
    const list = container.querySelector(".locate-list");
    expect(list).toBeInTheDocument();
    const items = list?.querySelectorAll("li");
    expect(items?.length).toBe(2);
    expect(items?.[0]?.textContent).toContain("近景点"); // 更近，排第一
    expect(items?.[1]?.textContent).toContain("远景点");
    expect(items?.[0]?.textContent).toMatch(/公里|米/); // 距离已格式化
  });

  it("定位但今天的景点都没坐标 → 明确降级，不编距离", async () => {
    render(<PlanView plan={duringPlan()} />); // duringPlan 的 spot 无 location
    await userEvent.click(screen.getByText("定位我在哪"));
    expect(await screen.findByText(/都没有坐标/)).toBeInTheDocument();
  });
});
