import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { HomeClient } from "@/app/home-client";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

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
