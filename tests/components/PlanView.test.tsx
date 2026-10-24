import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  ...SAMPLE_PLAN.days[0].spots[0],
  name,
  time,
  type,
  ...(location ? { location } : {}),
});
const duringPlan = () => ({
  ...SAMPLE_PLAN,
  startDate: mockClock.today,
  days: [
    {
      ...SAMPLE_PLAN.days[0],
      spots: [
        mkSpot("上午景点", "08:00-10:00", "sight"),
        mkSpot("中午餐厅", "10:15-11:15", "food"),
        mkSpot("下午景点", "11:30-12:50", "sight"),
      ],
    },
    ...SAMPLE_PLAN.days.slice(1),
  ],
});

// 第一天 spot 带坐标的行程，供「定位我在哪」断言距离排序
const duringPlanLocated = () => {
  const base = duringPlan();
  return {
    ...base,
    days: [
      {
        ...base.days[0],
        spots: [
          mkSpot("近景点", "08:00-10:00", "sight", "104.07,30.58"),
          mkSpot("远景点", "10:15-11:15", "sight", "104.20,30.80"),
        ],
      },
      ...base.days.slice(1),
    ],
  };
};

describe("PlanView", () => {
  it("渲染行程头部：城市/天数/总价/验真状态", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(
      screen.getByText(`${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`),
    ).toBeInTheDocument();
    // 预算透视卡在没有 budgetCny 的旧数据上也会回显「人均总花费」，故用 getAll
    expect(screen.getAllByText(/人均总花费/).length).toBeGreaterThan(0);
    // MOCK 模式的行程：verified=false → 显示未验真标注
    expect(screen.getByText(/未接高德/)).toBeInTheDocument();
  });

  it("事实先行徽章：有 grounding 摘要时如实展示候选规模与避开的闭馆日", () => {
    const plan = {
      ...SAMPLE_PLAN,
      grounding: { candidates: 18, closedSkipped: 3, closedOut: 1 },
    };
    render(<PlanView plan={plan} />);
    expect(screen.getByText(/事实先行/)).toBeInTheDocument();
    expect(screen.getByText(/18 个已核验候选/)).toBeInTheDocument();
    expect(screen.getByText(/避开 3 个闭馆日/)).toBeInTheDocument();
  });

  it("没有事实层时不显示徽章（不假装用过）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.queryByText(/事实先行/)).not.toBeInTheDocument();
  });

  it("KPI 三张统计卡：人均总花费 / 行程天数 / 景点餐点，各带图标", () => {
    const { container } = render(<PlanView plan={SAMPLE_PLAN} />);
    // 同上：KPI 标签与预算透视的兜底文案都是「人均总花费」
    expect(screen.getAllByText("人均总花费").length).toBeGreaterThan(0);
    expect(screen.getByText("行程天数")).toBeInTheDocument();
    expect(screen.getByText("景点 / 餐点")).toBeInTheDocument();
    expect(container.querySelectorAll(".kpi").length).toBe(3);
    expect(container.querySelectorAll(".kpi-icon").length).toBe(3);
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
      expect(
        screen.getByText(new RegExp(`行程体检发现 ${SAMPLE_PLAN.warnings.length} 个问题`)),
      ).toBeInTheDocument();
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

  it("雨天备选标注渲染（弱化一行：标签与内容分开，不再是一张卡的横幅）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    const withBackup = SAMPLE_PLAN.days.flatMap((d) => d.spots).find((s) => s.rainBackup);
    if (withBackup) {
      // 多个室外景点都会带雨天备选：用 getAllByText 断言「至少一条且文案完整」
      expect(screen.getAllByText("雨天备选").length).toBeGreaterThan(0);
      expect(
        screen.getAllByText(new RegExp(withBackup.rainBackup!.slice(0, 10))).length,
      ).toBeGreaterThan(0);
    }
  });

  it("分享按钮只在提供 shareId 时出现", () => {
    const { rerender } = render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.queryByText("复制分享链接")).not.toBeInTheDocument();
    expect(screen.queryByText(/下载日历/)).not.toBeInTheDocument();

    rerender(<PlanView plan={SAMPLE_PLAN} shareId="job_test123" />);
    expect(screen.getByText("复制分享链接")).toBeInTheDocument();
    expect(screen.getByText("下载日历（.ics）")).toHaveAttribute(
      "href",
      "/api/plan/ics?id=job_test123",
    );
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
          success({
            coords: { longitude: 104.06, latitude: 30.57 },
          } as unknown as GeolocationPosition),
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
      json: async () => ({
        state: "ok",
        days: [
          // 注意：组件消费的是端点响应（fetchWeather 转换后的 camelCase DayWeather），
          // 不是高德原始的小写字段——用错字段名会让展示全空（实测踩过）
          {
            date: mockClock.today,
            dayWeather: "小雨",
            nightWeather: "多云",
            dayTemp: "24",
            nightTemp: "18",
          },
        ],
      }),
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

// ============================================================
// 可执行性（本轮）：真实 POI 数据 chips + 一键修复 + 行中模式入口
//
// 这些能力都建立在「持久化行程（shareId）+ 真实高德数据」之上：
// - 没有 poi 数据 → 不渲染 chips（不猜）
// - 没有 shareId / 只读链接 → 不渲染修复按钮（不给点了必失败的假动作）
// ============================================================
describe("PlanView 可执行性（POI 真实数据 / 一键修复）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const POI = {
    rating: 4.8,
    openTime: "09:00-17:00",
    openTime2: "周一至周日 09:00-17:00",
    avgCostCny: 65,
    tel: "0512-67575666",
  };

  function planWithPoi(overrides: { temporarilyClosed?: boolean } = {}) {
    // 第一个点（景点）挂完整 POI 数据；当天第一个餐饮点单独挂「人均参考价」，
    // 验证不同 chip 只在对应类型上出现（餐饮人均参考价对景点没有意义）。
    let foodPoiAdded = false;
    return {
      ...SAMPLE_PLAN,
      days: SAMPLE_PLAN.days.map((d, i) =>
        i === 0
          ? {
              ...d,
              spots: d.spots.map((sp, j) => {
                if (j === 0) return { ...sp, poi: { ...POI, ...overrides } };
                if (!foodPoiAdded && sp.type === "food") {
                  foodPoiAdded = true;
                  return { ...sp, poi: { avgCostCny: 65 } };
                }
                return sp;
              }),
            }
          : d,
      ),
    };
  }

  function planWithWarnings(warnings: string[]) {
    return { ...SAMPLE_PLAN, warnings };
  }

  const editableProps = { shareId: "share_test123", editable: true } as const;

  it("行程点展示真实 POI 数据：评分 / 营业时间 / 餐饮人均参考价 / 电话", () => {
    render(<PlanView plan={planWithPoi()} />);
    expect(screen.getByText("★ 4.8")).toBeInTheDocument();
    expect(screen.getByText(/营业 09:00-17:00/)).toBeInTheDocument();
    expect(screen.getByText(/人均参考 ¥65/)).toBeInTheDocument();
    const tel = screen.getByTitle(/拨打 0512-67575666/);
    expect(tel.getAttribute("href")).toBe("tel:0512-67575666");
  });

  it("高德显示暂停开放 → 明确的红色 chip（不假装它还能去）", () => {
    render(<PlanView plan={planWithPoi({ temporarilyClosed: true })} />);
    expect(screen.getByText("暂停开放")).toBeInTheDocument();
  });

  it("可修复预警给出对应按钮：绕路→收拢动线、闭馆→避开闭馆、时间轴→一键顺延", () => {
    render(
      <PlanView
        plan={planWithWarnings([
          "第 1 天站点间通勤约 2 小时 30 分钟，偏长，可能存在绕路，建议合并同区域景点",
          "第 2 天「苏州博物馆」周一闭馆（高德：周一 全天不开放），当天去不了，建议换一个点或调到其他天",
          "第 3 天有 1 段「时间接不上」：「A」10:00 结束到「B」10:15 开始只有 15 分钟，但驾车约需 22 分钟——可用「一键顺延」重排当天时间轴",
        ])}
        {...editableProps}
      />,
    );
    expect(screen.getByText("收拢动线")).toBeInTheDocument();
    expect(screen.getByText("避开闭馆")).toBeInTheDocument();
    expect(screen.getByText("一键顺延")).toBeInTheDocument();
  });

  it("修不了的预警不给按钮（未验真不能说「一键修复」）", () => {
    render(
      <PlanView
        plan={planWithWarnings([
          "第 1 天「拙政园」未在高德检索到，可能名称有误或已关闭，出发前请自行确认",
        ])}
        {...editableProps}
      />,
    );
    expect(document.querySelectorAll(".warn-fix").length).toBe(0);
  });

  it("只读分享链接（未 editable）不渲染修复按钮", () => {
    render(
      <PlanView
        plan={planWithWarnings([
          "第 1 天站点间通勤约 2 小时 30 分钟，偏长，可能存在绕路，建议合并同区域景点",
        ])}
        shareId="share_readonly1"
      />,
    );
    expect(document.querySelectorAll(".warn-fix").length).toBe(0);
  });

  it("点「一键顺延」→ POST /api/plan/adjust（op=retime + 第 N 天），成功后展示版本", async () => {
    const fixed = { ...SAMPLE_PLAN, days: SAMPLE_PLAN.days.map((d) => ({ ...d })) };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ plan: fixed, revision: 2, changed: true, notes: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PlanView
        plan={planWithWarnings(["第 3 天有 1 段「时间接不上」：…可用「一键顺延」重排当天时间轴"])}
        {...editableProps}
      />,
    );
    await userEvent.click(screen.getByText("一键顺延"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan/adjust");
    expect(JSON.parse(String(init.body))).toEqual({
      shareId: "share_test123",
      op: "retime",
      day: 3,
    });
    expect(await screen.findByText(/已按真实路段时长顺延第 3 天时间轴/)).toBeInTheDocument();
    expect(screen.getByText(/已更新 · 第 2 版/)).toBeInTheDocument();
  });

  it("点「一键修复」（AI 类）→ POST /api/plan/refine（action=fix + fixKind + day）", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        plan: SAMPLE_PLAN,
        revision: 3,
        appliedFix: {
          fixKind: "transit",
          instruction: "第1天景点收拢到同一区域，减少跨区折返，当天通勤控制在1小时内",
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PlanView
        plan={planWithWarnings([
          "第 1 天站点间通勤约 2 小时 30 分钟，偏长，可能存在绕路，建议合并同区域景点",
        ])}
        {...editableProps}
      />,
    );
    await userEvent.click(screen.getByText("收拢动线"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan/refine");
    expect(JSON.parse(String(init.body))).toEqual({
      shareId: "share_test123",
      action: "fix",
      fixKind: "transit",
      day: 1,
    });
    expect(await screen.findByText(/已按「收拢动线」调整/)).toBeInTheDocument();
  });

  it("修复失败 → 展示服务端可行动文案，不显示成功提示", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "第 1 天当前安排已在合理节奏区间内，无需再调整" }),
      })),
    );
    render(
      <PlanView
        plan={planWithWarnings([
          "第 1 天安排约 10 小时 5 分钟，超出适中节奏上限（10 小时），可删减 1 个景点",
        ])}
        {...editableProps}
      />,
    );
    await userEvent.click(screen.getByText("减轻节奏"));
    expect(await screen.findByText(/无需再调整/)).toBeInTheDocument();
    expect(screen.queryByText(/已按「减轻节奏」调整/)).not.toBeInTheDocument();
  });

  it("有 shareId 时渲染「行中模式」入口（/t/<shareId>）", () => {
    render(<PlanView plan={SAMPLE_PLAN} shareId="share_today01" />);
    const link = screen.getByText("行中模式").closest("a")!;
    expect(link.getAttribute("href")).toBe("/t/share_today01");
  });

  it("无 shareId 时不渲染行中模式入口（示例行程没有持久化 token）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.queryByText("行中模式")).not.toBeInTheDocument();
  });
});

// ============================================================
// 行程可共编（本轮产品跃迁）：换一个 / 一句话改 / 版本徽章 / 导航
//
// 组件只负责交互与请求契约，真正的 LLM 调用与落库在 /api/plan/refine；
// 这里 mock fetch 断言「请求对不对 + 响应怎么渲染 + 失败怎么提示」。
// ============================================================
describe("PlanView 行程修改", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // 在 fixture 基础上造一份「修改后」的行程：第一天的第一个点被替换
  function planWithRenamedFirstSpot(name: string) {
    return {
      ...SAMPLE_PLAN,
      days: SAMPLE_PLAN.days.map((d, i) =>
        i === 0 ? { ...d, spots: d.spots.map((s, j) => (j === 0 ? { ...s, name } : s)) } : d,
      ),
    };
  }

  const editableProps = { shareId: "share_test123", editable: true } as const;

  it("只读模式（未传 editable）不渲染任何修改入口——分享出去的只读链接不能改", () => {
    render(<PlanView plan={SAMPLE_PLAN} shareId="share_test123" />);
    expect(screen.queryByText("重排这天")).not.toBeInTheDocument();
    expect(screen.queryByText("换一个")).not.toBeInTheDocument();
    expect(screen.queryByText("一句话改")).not.toBeInTheDocument();
  });

  it("editable：每天有「重排这天/一句话改」，每个行程点有「换一个」", () => {
    render(<PlanView plan={SAMPLE_PLAN} {...editableProps} />);
    expect(screen.getAllByText("重排这天")).toHaveLength(SAMPLE_PLAN.days.length);
    expect(screen.getAllByText("一句话改")).toHaveLength(SAMPLE_PLAN.days.length);
    // 住宿/交通是行程骨架，不渲染「换一个」（服务端也会拒绝），只数可换类型
    const swappable = new Set(["sight", "food", "shopping", "activity"]);
    const spotCount = SAMPLE_PLAN.days.reduce(
      (n, d) => n + d.spots.filter((x) => swappable.has(x.type)).length,
      0,
    );
    expect(screen.getAllByText("换一个")).toHaveLength(spotCount);
  });

  it("ownerCheck：分享页里本机没生成过该行程 → 即使 ?edit=1 也只读", () => {
    render(<PlanView plan={SAMPLE_PLAN} shareId="share_not_mine" editable ownerCheck />);
    expect(screen.queryByText("换一个")).not.toBeInTheDocument();
  });

  it("点「换一个」→ POST /api/plan/refine（action=swap + day + spotIndex），成功后渲染新点与版本号", async () => {
    const updated = planWithRenamedFirstSpot("替换后的新景点名称很长");
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ plan: updated, revision: 2 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PlanView plan={SAMPLE_PLAN} {...editableProps} />);
    await userEvent.click(screen.getAllByText("换一个")[0]);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/plan/refine");
    expect(JSON.parse(String(init.body))).toMatchObject({
      shareId: "share_test123",
      action: "swap",
      day: 1,
      spotIndex: 0,
    });

    expect(await screen.findByText("替换后的新景点名称很长")).toBeInTheDocument();
    expect(screen.getByText(/已更新 · 第 2 版/)).toBeInTheDocument();
  });

  it("「一句话改」→ 输入自然语言指令后提交，请求带 instruction", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ plan: SAMPLE_PLAN, revision: 3 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<PlanView plan={SAMPLE_PLAN} {...editableProps} />);
    // 第一天的「一句话改」按钮（每天各一个）
    await userEvent.click(screen.getAllByText("一句话改")[0]);
    const input = screen.getByLabelText("第 1 天修改指令");
    await userEvent.type(input, "想轻松点，多安排室内");
    await userEvent.click(screen.getByText("改这一天"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      shareId: "share_test123",
      action: "day",
      day: 1,
      instruction: "想轻松点，多安排室内",
    });
  });

  it("修改失败 → 展示服务端给的可行动错误文案（不吞错、不假装成功）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ error: "改行程太频繁（每小时 20 次），请稍后再试" }),
      })),
    );
    render(<PlanView plan={SAMPLE_PLAN} {...editableProps} />);
    await userEvent.click(screen.getAllByText("换一个")[0]);
    expect(await screen.findByText(/每小时 20 次/)).toBeInTheDocument();
    // 失败时不应出现版本号徽章（没有真的改成）
    expect(screen.queryByText(/已更新 · 第/)).not.toBeInTheDocument();
  });

  it("有坐标的行程点渲染「导航到这里」外链（高德 URI，新窗口 + noopener）", () => {
    const plan = {
      ...SAMPLE_PLAN,
      days: SAMPLE_PLAN.days.map((d, i) =>
        i === 0
          ? {
              ...d,
              spots: d.spots.map((s, j) => (j === 0 ? { ...s, location: "104.07,30.60" } : s)),
            }
          : d,
      ),
    };
    render(<PlanView plan={plan} />);
    const links = screen.getAllByText("导航到这里");
    expect(links.length).toBe(1);
    const a = links[0].closest("a")!;
    expect(a.getAttribute("href")).toContain("uri.amap.com/navigation");
    expect(a.getAttribute("href")).toContain("104.07,30.60");
    expect(a).toHaveAttribute("target", "_blank");
    expect(a.getAttribute("rel")).toContain("noopener");
  });

  it("打印 / 存 PDF 入口存在（打印样式在 globals.css 里收敛交互元素）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getByText("打印 / 存 PDF")).toBeInTheDocument();
  });
});
