import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { HomeClient } from "@/app/home-client";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { loadPendingJob, savePendingJob } from "@/lib/pending-job";

// 任务句柄落 localStorage：每条用例后清掉，避免「恢复上一个用例的 pending 任务」
// 这种跨用例污染（新逻辑引入的测试隔离要求）。
// 同时清掉上一个用例注入的 geolocation（jsdom 默认没有）：否则后续用例挂载时
// 会走定位分支，拿打桩的空响应把城市设成 undefined。
afterEach(() => {
  window.localStorage.clear();
  Reflect.deleteProperty(navigator, "geolocation");
});

// Home 挂载时请求 /api/me；提交时 POST /api/plan 再轮询 status
function mockFetchSequence() {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/me") {
      return {
        ok: true,
        json: async () => ({ loggedIn: false, remaining: null, provider: "none" }),
      };
    }
    if (url === "/api/plan") {
      return { ok: true, status: 202, json: async () => ({ jobId: "job_test_001" }) };
    }
    if (url.startsWith("/api/plan/status")) {
      return { ok: true, json: async () => ({ status: "done", plan: SAMPLE_PLAN, remaining: 2 }) };
    }
    // 必游地推荐：默认返回两条，供「点选即入库」用例断言
    if (url.startsWith("/api/places/recommend")) {
      return {
        ok: true,
        json: async () => ({
          sights: [
            { name: "苏州博物馆(本馆)", area: "姑苏区", rating: 4.8 },
            { name: "拙政园", area: "姑苏区", rating: 4.7 },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  });
  return calls;
}

describe("Home 表单", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("渲染全部输入控件（含新增的时间选择器/节奏/住所/必游地）", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    expect(screen.getByPlaceholderText("如：成都")).toBeInTheDocument();
    expect(screen.getByText("起始时间")).toBeInTheDocument();
    expect(screen.getByText("结束时间")).toBeInTheDocument();
    expect(screen.getByText("行程节奏")).toBeInTheDocument();
    expect(screen.getByText("轻松")).toBeInTheDocument();
    expect(screen.getByText("每天 1-3 个主景点")).toBeInTheDocument();
    expect(screen.getByText("我的住所")).toBeInTheDocument();
    expect(screen.getByText("期望必游地")).toBeInTheDocument();
    // 两个 datetime-local 输入
    expect(document.querySelectorAll('input[type="datetime-local"]')).toHaveLength(2);
  });

  it("预算为空：提交禁用并提示「穷游可填 0」，不预填任何金额", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    const btn = screen.getByText("请填写人均预算（穷游可填 0）").closest("button");
    expect(btn).toBeDisabled();

    // 点「穷游 0」快捷档后即可提交
    await userEvent.click(screen.getByText("穷游 0"));
    expect(screen.getByText("生成行程").closest("button")).not.toBeDisabled();
  });

  it("必游地：输入后点添加成为标签，可删除", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/期望必游地/)).toBeInTheDocument());

    const input = screen.getByPlaceholderText("输入地名后点添加，或回车");
    await userEvent.type(input, "三星堆");
    await userEvent.click(screen.getByText("添加"));
    expect(screen.getByText("三星堆")).toBeInTheDocument();

    // 删除
    await userEvent.click(screen.getByText("×"));
    expect(screen.queryByText("三星堆")).not.toBeInTheDocument();
  });

  it("必游地推荐：填了城市后出现真实 POI  chips，点选即入库", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/期望必游地/)).toBeInTheDocument());

    const cityInput = screen.getByPlaceholderText("如：成都");
    await userEvent.type(cityInput, "苏州");

    // 推荐 chips 来自高德真实 POI（含评分），不是占位文本
    await waitFor(
      () => expect(screen.getByRole("group", { name: "推荐必游地" })).toBeInTheDocument(),
      {
        timeout: 3000,
      },
    );
    const chip = screen.getByRole("button", { name: /苏州博物馆/ });
    expect(chip).toBeInTheDocument();

    // 点选即入库（不再需要手打 + 点添加）
    await userEvent.click(chip);
    expect(screen.getByText("苏州博物馆(本馆)")).toBeInTheDocument();
    // 入库后从推荐里消失，避免重复添加（注意：必游地标签自带的「删除」按钮
    // 名字里也含地点名，所以要限定在推荐组内断言）
    const group = screen.getByRole("group", { name: "推荐必游地" });
    expect(within(group).queryByRole("button", { name: /苏州博物馆/ })).not.toBeInTheDocument();
  });

  it("必游地：回车也可添加，且去重", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/期望必游地/)).toBeInTheDocument());

    const input = screen.getByPlaceholderText("输入地名后点添加，或回车");
    await userEvent.type(input, "都江堰{Enter}");
    await userEvent.type(input, "都江堰{Enter}");
    expect(screen.getAllByText("都江堰")).toHaveLength(1); // 去重
  });

  it("提交：载荷含起止时间/节奏/住所/必游地，轮询完成后渲染行程", async () => {
    const calls = mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    await userEvent.clear(screen.getByPlaceholderText("如：成都"));
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.click(screen.getByText("紧凑"));

    const hotelInput = screen.getByPlaceholderText(/全季酒店/);
    await userEvent.type(hotelInput, "住春熙路附近");

    const mvInput = screen.getByPlaceholderText("输入地名后点添加，或回车");
    await userEvent.type(mvInput, "三星堆{Enter}");

    // 预算不再预填：测试也要像用户一样填一次
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    await userEvent.click(screen.getByText("生成行程"));

    await waitFor(() => expect(calls.some((c) => c.url === "/api/plan")).toBe(true), {
      timeout: 3000,
    });
    const submit = calls.find((c) => c.url === "/api/plan");
    expect(submit?.body).toMatchObject({
      city: "成都",
      pace: "packed",
      hotel: "住春熙路附近",
      mustVisit: ["三星堆"],
    });
    expect((submit?.body as { startAt: string }).startAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/,
    );

    // 轮询到 done 后渲染行程
    await waitFor(
      () =>
        expect(
          // 首屏的产品预览窗也含「苏州 · 3 天行程」；这里只认结果区文档头，
          // 避免全局 getByText 撞到 hero 的预览面板。
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it("默认节奏为适中（提交载荷 pace=balanced）", async () => {
    const calls = mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    // city 与预算都不再预填，两个都填才能提交
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    await userEvent.click(screen.getByText("生成行程"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/plan")).toBe(true), {
      timeout: 3000,
    });
    expect((calls.find((c) => c.url === "/api/plan")?.body as { pace: string }).pace).toBe(
      "balanced",
    );
  });

  it("点「手机号登录」展开登录表单（手机号 + 验证码 + 获取验证码/登录）", async () => {
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/手机号登录/));
    expect(screen.getByPlaceholderText("手机号")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("验证码")).toBeInTheDocument();
    expect(screen.getByText("获取验证码")).toBeInTheDocument();
    expect(screen.getByText("登录")).toBeInTheDocument();
  });
});

// 「最近行程」不再是新建页的 UI（入口在 / 我的行程），但生成完成后仍要写入
// localStorage 索引——否则用户回 / 时找不到刚生成的行程。
describe("Home 生成后写入最近行程", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it("生成完成后写入 localStorage（/ 据此恢复入口）", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: null, provider: "none" }),
        };
      }
      if (url === "/api/plan") {
        return { ok: true, status: 202, json: async () => ({ jobId: "job_test_001" }) };
      }
      if (url.startsWith("/api/plan/status")) {
        return {
          ok: true,
          json: async () => ({
            status: "done",
            plan: SAMPLE_PLAN,
            remaining: 2,
            shareId: "share_test001",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    await userEvent.click(screen.getByText("生成行程"));

    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    await waitFor(() => {
      const raw = window.localStorage.getItem("tp.recent-trips.v1") ?? "";
      expect(raw).toContain("share_test001");
    });
  });

  // 回归（真机踩过）：React StrictMode（dev 默认开）会 挂载→卸载→再挂载，
  // unmounted 标记若不在 effect setup 里复位，第二次挂载后永远卡在 true，
  // pollJob 第一行就 return——一次轮询都不发，前端干等到超时。
  // 症状：后台 job 早已 done，前端一直转圈。非 StrictMode 渲染抓不到，
  // 所以这里显式包一层 StrictMode。
  it("StrictMode 双挂载后，提交仍能轮询到 done 并渲染行程", async () => {
    const statusCalls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: 3, provider: "none" }),
        };
      }
      if (url === "/api/plan") {
        return { ok: true, status: 202, json: async () => ({ jobId: "job_strict_1" }) };
      }
      if (url.startsWith("/api/plan/status")) {
        statusCalls.push(url);
        return {
          ok: true,
          json: async () => ({
            status: "done",
            plan: SAMPLE_PLAN,
            remaining: 2,
            shareId: "share_strict",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    render(
      <StrictMode>
        <HomeClient />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    await userEvent.click(screen.getByText("生成行程"));
    // 关键：status 必须被调用过（修复前 StrictMode 下一次都不调）
    await waitFor(() => expect(statusCalls.length).toBeGreaterThan(0), { timeout: 4000 });
    await waitFor(
      () =>
        expect(
          // 首屏的产品预览窗也含「苏州 · 3 天行程」；这里只认结果区文档头，
          // 避免全局 getByText 撞到 hero 的预览面板。
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
  });
});

// 目的地城市默认值：不再硬编码「成都」。挂载时静默定位一次——拿到定位城市
// 才预填，拿不到（无权限/不支持/失败）就留空让用户自己输。这两条钉住这个契约。
describe("Home 目的地城市默认值", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("无定位能力时：城市留空、不预填，提交按钮禁用并提示先填城市", async () => {
    // 不 stub geolocation → jsdom 里 navigator.geolocation 不存在，
    // 挂载的静默定位走「不支持」分支静默失败（不弹错误）
    mockFetchSequence();
    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    const cityInput = screen.getByPlaceholderText("如：成都") as HTMLInputElement;
    expect(cityInput.value).toBe(""); // 没有预填任何城市
    // 空城市时提交按钮禁用，且文字提示先填城市
    expect(screen.getByText("请先填写目的地城市")).toBeInTheDocument();
    expect(screen.getByText("请先填写目的地城市").closest("button")).toBeDisabled();
  });

  it("定位成功时：预填定位城市，提交按钮恢复可用", async () => {
    // stub 定位：返回成都坐标；反解接口回成都
    const getCurrentPosition = vi.fn((success: (p: unknown) => void) => {
      success({ coords: { longitude: 104.06, latitude: 30.57 } });
    });
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    // jsdom 的 location 是 http://localhost，isSecureContext 求值为 false，
    // resolveCity 会在调 geolocation 前就返回。真实浏览器里 localhost 是安全
    // 上下文，所以这里按真实环境覆写为 true。
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: null, provider: "none" }),
        };
      }
      if (url.startsWith("/api/geocode/reverse")) {
        return { ok: true, json: async () => ({ city: "成都", formatted: "成都市武侯区" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<HomeClient />);
    await waitFor(() => {
      const cityInput = screen.getByPlaceholderText("如：成都") as HTMLInputElement;
      expect(cityInput.value).toBe("成都");
    });
    // 定位 + 填预算后提交按钮恢复可用
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    expect(screen.getByText("生成行程").closest("button")).not.toBeDisabled();
  });
});

// ============================================================
// 生成中的任务恢复（P0：离开/刷新页面不再丢结果）
//
// 以前 jobId 只活在组件 state：刷新=轮询丢失，服务端仍在跑、额度已扣，
// 用户却永远拿不到结果——而页面两处文案承诺「可以离开页面，结果会保留」。
// 现在提交成功即落 localStorage，挂载时自动续轮询；终态/过期清掉。
// ============================================================
describe("Home 生成中的任务恢复", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  // 恢复路径的 fetch 桩：/api/me + status。status 只回 done（任务在「离开期间」已完成）
  function stubResumeFetch(statusUrls: string[]) {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: 2, provider: "none" }),
        };
      }
      if (url.startsWith("/api/plan/status")) {
        statusUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            status: "done",
            plan: SAMPLE_PLAN,
            remaining: 2,
            shareId: "share_resumed",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
  }

  it("重开页面：从 localStorage 恢复 jobId，自动续轮询并渲染结果，终态清掉句柄", async () => {
    const statusUrls: string[] = [];
    // 模拟「两分钟前提交、随后离开页面」：createdAt 是过去时间
    savePendingJob({ jobId: "job_resume_1", createdAt: Date.now() - 120_000, days: 3 });
    stubResumeFetch(statusUrls);

    render(<HomeClient />);

    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    // 关键：轮询的是持久化的那个 jobId，而不是新任务
    expect(statusUrls.some((u) => u.includes("job_resume_1"))).toBe(true);
    // 完成后清掉句柄：下次打开不再续一个已结束的任务
    expect(loadPendingJob()).toBeNull();
  });

  it("提交成功立刻落盘 jobId；done 之后清掉（刷新窗口内可恢复）", async () => {
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((r) => {
      releaseStatus = r;
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: 3, provider: "none" }),
        };
      }
      if (url === "/api/plan") {
        return { ok: true, status: 202, json: async () => ({ jobId: "job_saved_1" }) };
      }
      if (url.startsWith("/api/plan/status")) {
        await statusGate; // 先卡住「生成中」，好断言落盘
        return {
          ok: true,
          json: async () => ({
            status: "done",
            plan: SAMPLE_PLAN,
            remaining: 2,
            shareId: "share_saved",
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.type(screen.getByPlaceholderText(/如：1500/), "3000");
    await userEvent.click(screen.getByText("生成行程"));

    // 轮询已发起（说明已过 202 分支）→ 句柄应在 localStorage 里，且带 days
    //（只断言「存了天数」而不钉死具体值：默认起止日期随当前时间滚动）
    await waitFor(() => expect(loadPendingJob()?.jobId).toBe("job_saved_1"));
    expect(loadPendingJob()?.days).toBeGreaterThan(0);

    releaseStatus();
    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(loadPendingJob()).toBeNull();
  });

  it("恢复的任务已被服务端清掉（404）：给出可行动提示并清句柄，不无限轮询", async () => {
    savePendingJob({ jobId: "job_gone", createdAt: Date.now() - 1000 });
    let statusCalls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: 3, provider: "none" }),
        };
      }
      if (url.startsWith("/api/plan/status")) {
        statusCalls += 1;
        return { ok: false, status: 404, json: async () => ({ error: "任务不存在或已过期" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<HomeClient />);
    await waitFor(() => expect(screen.getByText(/任务已过期或服务已重启/)).toBeInTheDocument());
    expect(statusCalls).toBe(1); // 404 立即停，不再每 3 秒转圈
    expect(loadPendingJob()).toBeNull();
  });

  it("深链 ?sample=1 不再依赖 useSearchParams：挂载后读 location 也能进示例", async () => {
    window.history.pushState({}, "", "/new?sample=1");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ loggedIn: false, remaining: null, provider: "none" }),
    }));
    render(<HomeClient />);
    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", {
            name: `${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`,
          }),
        ).toBeInTheDocument(),
      { timeout: 5000 },
    );
    window.history.pushState({}, "", "/");
  });
});

// ============================================================
// 首屏灵感卡的深链预填：/new?city=成都&days=4&prefs=美食,历史文化
//
// 卡片上的「用这个条件开始 →」只带「城市 / 天数 / 偏好」三项，预算留给用户
// 自己定（那是消费决策，不该被示例替他填）。这里钉住三件事：城市真的预填、
// 起止日期换算成对应日历日数、偏好按白名单选中。
// 另外钉一件容易回退的事：深链指定了城市时不再跑静默定位——否则用户点了
// 「成都 3 天」，进页面却被定位城市悄悄改掉。
// ============================================================
describe("Home 灵感卡深链预填", () => {
  afterEach(() => {
    // 恢复干净的 URL：jsdom 的 history 跨用例共享，留着 /new?city=… 会污染后面
    window.history.pushState({}, "", "/");
  });

  it("city/days/prefs 预填：城市=成都、起止跨 4 个日历日、偏好 chips 选中", async () => {
    window.history.pushState({}, "", "/new?city=成都&days=4&prefs=美食,历史文化");
    // 定位桩故意返回「北京」：只要静默定位还在跑，城市断言就会被改成北京
    const getCurrentPosition = vi.fn((success: (p: unknown) => void) => {
      success({ coords: { longitude: 116.4, latitude: 39.9 } });
    });
    Object.defineProperty(navigator, "geolocation", {
      value: { getCurrentPosition },
      configurable: true,
    });
    // jsdom 的 location 是 http://localhost，isSecureContext 为 false；
    // 真实浏览器里 localhost 是安全上下文，按真实环境覆写，否则定位分支提前返回、
    // 「没被定位覆盖」就变成因为定位不可用而通过（假绿）。
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url === "/api/me") {
        return {
          ok: true,
          json: async () => ({ loggedIn: false, remaining: null, provider: "none" }),
        };
      }
      if (url.startsWith("/api/geocode/reverse")) {
        return { ok: true, json: async () => ({ city: "北京", formatted: "北京市东城区" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<HomeClient />);

    // 城市：来自 URL 而不是定位（定位桩会返回北京）
    await waitFor(() => {
      expect((screen.getByPlaceholderText("如：成都") as HTMLInputElement).value).toBe("成都");
    });
    expect(getCurrentPosition).not.toHaveBeenCalled();

    // 起止日期：明天 10:00 → 第 4 天 18:00，含头含尾跨 4 个日历日
    const [startInput, endInput] = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'),
    );
    expect(startInput.value).toMatch(/T10:00$/);
    expect(endInput.value).toMatch(/T18:00$/);
    const calendarDays =
      Math.round(
        (Date.parse(`${endInput.value.slice(0, 10)}T00:00:00Z`) -
          Date.parse(`${startInput.value.slice(0, 10)}T00:00:00Z`)) /
          86400000,
      ) + 1;
    expect(calendarDays).toBe(4);
    // 表单自己算出的天数也必须是 4（预填只改 state，提示要跟着变）
    expect(screen.getByText(/共 4 天/)).toBeInTheDocument();

    // 偏好：URL 带的两个 chip 选中，其余保持未选
    expect(screen.getByRole("button", { name: "美食" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "历史文化" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "自然风光" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});
