import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripCheckDesk } from "@/components/TripCheckDesk";

// 这个组件最重要的不是「能出报告」，而是**中间那一步摊开确认**：
// AI 读出来的时间必须可见、可改，且不许夹带任何核验状态。
// /api/verify 在这里故意返回 500，避免把庞大的报告组件拉进单测，同时仍能
// 断言提交出去的请求体（报告组件另有 Playground/报告页的测试覆盖）。

const EXTRACTED = {
  specVersion: "trip-check/0.1",
  city: "苏州",
  budgetCny: 2000,
  days: [
    {
      day: 1,
      spots: [
        { name: "拙政园", time: "09:00-11:00" },
        { name: "苏州博物馆", time: "未标注" },
      ],
    },
  ],
};

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

let calls: Call[] = [];

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as unknown as Response;
}

function stubFetch(
  extract: unknown = {
    document: EXTRACTED,
    uncertain: ["第 1 天 · 苏州博物馆：原文没写明确时间，标为「未标注」。"],
    tokens: 12,
  },
) {
  calls = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ url: u, body });
    if (u.includes("/api/verify/extract")) return jsonResponse(extract);
    return jsonResponse({ error: "stub verify" }, 500);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

async function reachConfirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /贴一段示例试试/ }));
  await user.click(screen.getByRole("button", { name: /读一遍并体检/ }));
  await waitFor(() => expect(screen.getByText("先核对一下，我读到了这些")).toBeInTheDocument());
}

describe("行程验真台", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    stubFetch();
  });

  it("首屏第一动作是贴行程，且明说这一页不查外部数据", () => {
    render(<TripCheckDesk />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("先看看");
    expect(screen.getByLabelText("你的行程原文")).toBeInTheDocument();
    expect(screen.getByText(/不会查地点是否真实存在/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /读一遍并体检/ })).toBeDisabled();
  });

  it("抽取后先摊开确认：不确定项可见，没写时间显示为未标注", async () => {
    const user = userEvent.setup();
    render(<TripCheckDesk />);
    await reachConfirm(user);

    expect(screen.getByText(/第 1 天 · 苏州博物馆：原文没写明确时间/)).toBeInTheDocument();
    expect(screen.getByText("拙政园")).toBeInTheDocument();
    expect(screen.getByDisplayValue("未标注")).toBeInTheDocument();
    expect(screen.getByText(/我没有补任何东西/)).toBeInTheDocument();
  });

  it("改过的时刻才提交体检，且文档里没有任何伪造的核验字段", async () => {
    const user = userEvent.setup();
    render(<TripCheckDesk />);
    await reachConfirm(user);

    const input = screen.getByLabelText("第 1 天 苏州博物馆 的时间");
    await user.clear(input);
    await user.type(input, "13:00-14:30");
    await user.click(screen.getByRole("button", { name: /确认，开始体检/ }));

    await waitFor(() =>
      expect(
        calls.some(
          (c) =>
            c.url.includes("/api/verify") &&
            !c.url.includes("extract") &&
            !c.url.includes("repair"),
        ),
      ).toBe(true),
    );
    const verify = calls.find(
      (c) =>
        c.url.includes("/api/verify") && !c.url.includes("extract") && !c.url.includes("repair"),
    );
    const doc = (verify?.body?.document ?? {}) as {
      days: { spots: { name: string; time: string; verification?: unknown }[] }[];
    };
    expect(doc.days[0].spots[1].time).toBe("13:00-14:30");
    expect(doc.days[0].spots[0].verification).toBeUndefined();
  });

  it("读不出点位时如实提示，不假装生成了一份文档", async () => {
    stubFetch({ document: null, uncertain: ["没读到点位"], tokens: 3 });
    const user = userEvent.setup();
    render(<TripCheckDesk />);
    await reachConfirmFail(user);
    expect(screen.getByRole("alert")).toHaveTextContent("没读到行程点位");
  });

  it("抽取接口报错时把服务端的话原样显示出来", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "读取失败：模型没有返回内容" }, 502)),
    );
    const user = userEvent.setup();
    render(<TripCheckDesk />);
    await user.click(screen.getByRole("button", { name: /贴一段示例试试/ }));
    await user.click(screen.getByRole("button", { name: /读一遍并体检/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("模型没有返回内容"));
  });
});

async function reachConfirmFail(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /贴一段示例试试/ }));
  await user.click(screen.getByRole("button", { name: /读一遍并体检/ }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
}
