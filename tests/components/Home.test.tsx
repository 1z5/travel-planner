import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "@/app/page";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// Home 挂载时请求 /api/me；提交时 POST /api/plan 再轮询 status
function mockFetchSequence() {
  const calls: Array<{ url: string; body?: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (url === "/api/me") {
      return { ok: true, json: async () => ({ loggedIn: false, remaining: null, provider: "none" }) };
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
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    expect(screen.getByPlaceholderText("如：成都")).toBeInTheDocument();
    expect(screen.getByText("起始时间")).toBeInTheDocument();
    expect(screen.getByText("结束时间")).toBeInTheDocument();
    expect(screen.getByText("行程节奏")).toBeInTheDocument();
    expect(screen.getByText(/轻松（每天 1-3 个主景点）/)).toBeInTheDocument();
    expect(screen.getByText("我的住所（选填，全程以此为基地）")).toBeInTheDocument();
    expect(screen.getByText("期望必游地（选填，最多 5 个，必须全部安排）")).toBeInTheDocument();
    // 两个 datetime-local 输入
    expect(document.querySelectorAll('input[type="datetime-local"]')).toHaveLength(2);
  });

  it("必游地：输入后点添加成为标签，可删除", async () => {
    mockFetchSequence();
    render(<Home />);
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
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/期望必游地/)).toBeInTheDocument());

    const input = screen.getByPlaceholderText("输入地名后点添加，或回车");
    await userEvent.type(input, "都江堰{Enter}");
    await userEvent.type(input, "都江堰{Enter}");
    expect(screen.getAllByText("都江堰")).toHaveLength(1); // 去重
  });

  it("提交：载荷含起止时间/节奏/住所/必游地，轮询完成后渲染行程", async () => {
    const calls = mockFetchSequence();
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());

    await userEvent.clear(screen.getByPlaceholderText("如：成都"));
    await userEvent.type(screen.getByPlaceholderText("如：成都"), "成都");
    await userEvent.click(screen.getByText("紧凑（3-5 个）"));

    const hotelInput = screen.getByPlaceholderText(/全季酒店/);
    await userEvent.type(hotelInput, "住春熙路附近");

    const mvInput = screen.getByPlaceholderText("输入地名后点添加，或回车");
    await userEvent.type(mvInput, "三星堆{Enter}");

    await userEvent.click(screen.getByText("生成行程"));

    await waitFor(() => expect(calls.some((c) => c.url === "/api/plan")).toBe(true), { timeout: 3000 });
    const submit = calls.find((c) => c.url === "/api/plan");
    expect(submit?.body).toMatchObject({
      city: "成都",
      pace: "packed",
      hotel: "住春熙路附近",
      mustVisit: ["三星堆"],
    });
    expect((submit?.body as { startAt: string }).startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

    // 轮询到 done 后渲染行程
    await waitFor(() => expect(screen.getByText(`${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`)).toBeInTheDocument(), { timeout: 5000 });
  });

  it("默认节奏为适中（提交载荷 pace=balanced）", async () => {
    const calls = mockFetchSequence();
    render(<Home />);
    await waitFor(() => expect(screen.getByText(/手机号登录/)).toBeInTheDocument());
    await userEvent.click(screen.getByText("生成行程"));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/plan")).toBe(true), { timeout: 3000 });
    expect((calls.find((c) => c.url === "/api/plan")?.body as { pace: string }).pace).toBe("balanced");
  });
});
