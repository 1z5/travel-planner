import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CloneCTA } from "@/components/CloneCTA";
import type { Plan } from "@/lib/types";

// useRouter 在 jsdom 里没有 App Router 上下文——mock 掉，本测试不验证跳转
// （跳转依赖轮询 done 分支，由 e2e 覆盖），只验证 UI 契约与请求载荷。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));

// 切片2 · 一键克隆：分享页 CTA 组件测试。
// 钉住的契约：
// 1. 按钮与说明文案就位（说明承诺的是「重新核验」机制而非情绪）；
// 2. 展开表单：日期默认错峰 +7 天（星期几与原行程一致），预算预填原值；
// 3. 提交 → POST /api/plan/clone 载荷含 shareId 与 overrides；
// 4. 429 配额文案原样透传（不吞错、不编造）。

function makePlan(): Plan {
  return {
    city: "苏州",
    startDate: "2026-10-19",
    endDate: "2026-10-21",
    startAt: "2026-10-19T10:00",
    endAt: "2026-10-21T18:00",
    summary: "苏州 3 天",
    days: [
      { day: 1, theme: "园林", spots: [], transitMin: 0, dailyCostCny: 0 },
      { day: 2, theme: "古镇", spots: [], transitMin: 0, dailyCostCny: 0 },
      { day: 3, theme: "湖光", spots: [], transitMin: 0, dailyCostCny: 0 },
    ],
    totalCostCny: 2500,
    budgetCny: 3000,
    tips: [],
    warnings: [],
    verified: true,
  };
}

describe("CloneCTA", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("按钮与说明就位：说明承诺的是「重新核验」机制", () => {
    render(<CloneCTA plan={makePlan()} shareId="share_abc" />);
    expect(screen.getByText("克隆这份行程，改成我的日期")).toBeTruthy();
    expect(screen.getByText(/按新日期重新核查闭馆与通勤/)).toBeTruthy();
  });

  it("展开表单：日期默认错峰 +7 天（星期几一致），预算预填原行程", async () => {
    const user = userEvent.setup();
    render(<CloneCTA plan={makePlan()} shareId="share_abc" />);
    await user.click(screen.getByText("克隆这份行程，改成我的日期"));

    // 2026-10-19（周一）+7 天 = 2026-10-26（仍是周一）
    const start = screen.getByLabelText("我的出发时间") as HTMLInputElement;
    const end = screen.getByLabelText("我的结束时间") as HTMLInputElement;
    expect(start.value).toBe("2026-10-26T10:00");
    expect(end.value).toBe("2026-10-28T18:00");

    // 预算预填原用户预算（plan.budgetCny），节奏用居中默认
    const budget = screen.getByLabelText("我的人均预算（元）") as HTMLInputElement;
    expect(budget.value).toBe("3000");
  });

  it("提交：POST /api/plan/clone 载荷含 shareId 与 overrides", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      status: 202,
      json: async () => ({ jobId: "job_clone001" }),
    });
    // 轮询：一次 running 后 done，避免长轮询挂住测试
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/plan/clone")) {
        return Promise.resolve({ status: 202, json: async () => ({ jobId: "job_clone001" }) });
      }
      return Promise.resolve({
        status: 200,
        json: async () => ({ status: "done", shareId: "share_new", plan: makePlan() }),
      });
    });

    render(<CloneCTA plan={makePlan()} shareId="share_abc" />);
    await user.click(screen.getByText("克隆这份行程，改成我的日期"));
    await user.click(screen.getByText("开始克隆"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/plan/clone",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"shareId":"share_abc"'),
        }),
      );
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.overrides).toMatchObject({
      startAt: "2026-10-26T10:00",
      endAt: "2026-10-28T18:00",
      budget: 3000,
      pace: "balanced",
    });
  });

  it("429 配额文案原样透传（不吞错、不编造）", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue({
      status: 429,
      json: async () => ({
        error: "今日免费次数已用完（未登录每天 3 次）。登录后可提升到 10 次/天。",
      }),
    });

    render(<CloneCTA plan={makePlan()} shareId="share_abc" />);
    await user.click(screen.getByText("克隆这份行程，改成我的日期"));
    await user.click(screen.getByText("开始克隆"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("今日免费次数已用完");
    });
  });
});
