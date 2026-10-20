import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanCopilot } from "@/components/PlanCopilot";
import type { CopilotSuggestion } from "@/lib/copilot-types";

// 「行程管家」组件测试：钉住请求契约（/api/plan/chat + 最近 8 条 + 最后一条 user）、
// 纯文本渲染、建议按钮的二次确认、错误如实展示、等待期防并发与清空对话。
// fetch 一律 stub，不触网；后端真实行为由 API/集成测试覆盖。

interface ChatBody {
  shareId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function lastRequest(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch 未被调用");
  const [url, init] = call as unknown as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) as ChatBody };
}

const TRANSIT_SUGGESTION: CopilotSuggestion = {
  kind: "fix",
  fixKind: "transit",
  day: 2,
  label: "收拢第 2 天动线",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PlanCopilot", () => {
  it("默认展开：渲染标题/副标题/6 个推荐问题/免责声明与无障碍属性", () => {
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "行程管家" })).toBeInTheDocument();
    expect(screen.getByText("基于这份行程回答（step-5）")).toBeInTheDocument();
    expect(document.querySelectorAll(".copilot-chip")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "第二天来得及吗" })).toBeInTheDocument();
    expect(screen.getByText(/回答只基于这份行程与高德真实数据/)).toBeInTheDocument();

    expect(screen.getByRole("log")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByLabelText("向行程管家提问")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /收起/ })).toHaveAttribute("aria-expanded", "true");
    // 空对话时没有可清空的内容
    expect(screen.getByRole("button", { name: /清空对话/ })).toBeDisabled();
  });

  it("可折叠：收起隐藏对话区，展开后恢复", async () => {
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /收起/ }));
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("向行程管家提问")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /展开/ })).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByRole("button", { name: /展开/ }));
    expect(screen.getByRole("log")).toBeInTheDocument();
    expect(screen.getByLabelText("向行程管家提问")).toBeInTheDocument();
  });

  it("点推荐问题即发送：POST /api/plan/chat，body 带 shareId 且最后一条是 user", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answer: "第二天安排比较松。" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "第二天来得及吗" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { url, init, body } = lastRequest(fetchMock);
    expect(url).toBe("/api/plan/chat");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(body).toEqual({
      shareId: "share_test123",
      messages: [{ role: "user", content: "第二天来得及吗" }],
    });
    expect(await screen.findByText("第二天安排比较松。")).toBeInTheDocument();
  });

  it("成功答案按纯文本渲染：HTML 标签显示为字面量而不是标签", async () => {
    const answer = "第二天 09:00 出发即可，<b>不用赶</b>。";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ answer })),
    );
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    await user.type(screen.getByLabelText("向行程管家提问"), "第二天来得及吗");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText(answer)).toBeInTheDocument();
    expect(document.querySelector(".copilot-msg-assistant b")).toBeNull();
    // 无 suggestion 时不应凭空出现建议按钮
    expect(document.querySelector(".copilot-suggestion")).toBeNull();
  });

  it("有 suggestion：按钮带 label + 说明，点击调用 onSuggestion 后禁用并显示已交给", async () => {
    const onSuggestion = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          answer: "第 2 天通勤偏长，可以把景点收拢到同一区域。",
          suggestion: TRANSIT_SUGGESTION,
        }),
      ),
    );
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={onSuggestion} />);

    await user.type(screen.getByLabelText("向行程管家提问"), "第二天会不会太赶");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const button = await screen.findByRole("button", { name: /收拢第 2 天动线/ });
    expect(button).toHaveTextContent("点一下交给行程修改");
    expect(button).toBeEnabled();

    await user.click(button);
    await waitFor(() => expect(onSuggestion).toHaveBeenCalledWith(TRANSIT_SUGGESTION));
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("已交给行程修改");
  });

  it("未传 onSuggestion：建议按钮禁用并用 title 说明原因", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          answer: "第 2 天通勤偏长。",
          suggestion: TRANSIT_SUGGESTION,
        }),
      ),
    );
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" />);

    await user.type(screen.getByLabelText("向行程管家提问"), "第二天会不会太赶");
    await user.click(screen.getByRole("button", { name: "发送" }));

    const button = await screen.findByRole("button", { name: /收拢第 2 天动线/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("未接入行程修改"));
  });

  it.each([
    [429, "问得太频繁了（每分钟 5 次），请稍后再试"],
    [502, "模型服务暂时不可用，请稍后再试"],
  ])("服务端 %i：直接展示 error 文案，不追加助手消息", async (status, message) => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: message }, status));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    const input = screen.getByLabelText("向行程管家提问");
    await user.type(input, "预算够吗");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    // 失败是失败：不出现助手答案，输入框恢复可用
    expect(document.querySelectorAll(".copilot-msg-assistant")).toHaveLength(0);
    expect(input).toBeEnabled();
  });

  it("网络异常：展示「网络异常，请重试」而不是静默失败", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    await user.type(screen.getByLabelText("向行程管家提问"), "第二天来得及吗");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(await screen.findByText("网络异常，请重试")).toBeInTheDocument();
    expect(document.querySelectorAll(".copilot-msg-assistant")).toHaveLength(0);
  });

  it("发送中：展示 spinner/已等待秒数，禁用输入与按钮，且不会发起第二个请求", async () => {
    let resolveFetch!: (res: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    const input = screen.getByLabelText("向行程管家提问");
    await user.type(input, "第二天来得及吗{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: /发送中/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /清空对话/ })).toBeDisabled();
    expect(screen.getByText("正在结合你的行程思考…")).toBeInTheDocument();
    expect(screen.getByText(/已等待 \d+ 秒/)).toBeInTheDocument();
    expect(document.querySelector(".copilot-spin")).not.toBeNull();

    // 等待中再按 Enter：inFlightRef 兜底，请求数不变
    await user.keyboard("{Enter}");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(jsonResponse({ answer: "来得及。" }));
    expect(await screen.findByText("来得及。")).toBeInTheDocument();
    expect(input).toBeEnabled();
  });

  it("多次发送时只带最近 8 条历史，最后一条仍是当前 user", async () => {
    let callNo = 0;
    const fetchMock = vi.fn(async () => jsonResponse({ answer: `回答${++callNo}` }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    const input = screen.getByLabelText("向行程管家提问");
    for (let i = 1; i <= 5; i++) {
      await user.type(input, `问题${i}`);
      await user.click(screen.getByRole("button", { name: "发送" }));
      expect(await screen.findByText(`回答${i}`)).toBeInTheDocument();
    }

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const { body } = lastRequest(fetchMock);
    // 第 5 次发送时总消息为 9 条，只取最近 8 条：A1 U2 A2 U3 A3 U4 A4 U5
    expect(body.messages).toHaveLength(8);
    expect(body.messages.map((m) => m.content)).toEqual([
      "回答1",
      "问题2",
      "回答2",
      "问题3",
      "回答3",
      "问题4",
      "回答4",
      "问题5",
    ]);
    expect(body.messages.at(-1)).toEqual({ role: "user", content: "问题5" });
  });

  it("Enter 发送、Shift+Enter 不发送（保留换行）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ answer: "好的。" }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    const input = screen.getByLabelText("向行程管家提问");
    await user.type(input, "第一行{Shift>}{Enter}{/Shift}第二行");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue("第一行\n第二行");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { body } = lastRequest(fetchMock);
    expect(body.messages[0]).toEqual({ role: "user", content: "第一行\n第二行" });
  });

  it("清空对话：消息与错误清空、输入清空，推荐问题重新出现", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ answer: "附近有两家面馆。" })),
    );
    const user = userEvent.setup();
    render(<PlanCopilot shareId="share_test123" onSuggestion={vi.fn()} />);

    const input = screen.getByLabelText("向行程管家提问");
    await user.type(input, "酒店附近有什么");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText("附近有两家面馆。")).toBeInTheDocument();
    expect(screen.getByText("酒店附近有什么")).toBeInTheDocument();

    // 清空前输入一些未发送内容，清空后也应一并清掉
    await user.type(input, "还没发的内容");
    await user.click(screen.getByRole("button", { name: /清空对话/ }));

    expect(document.querySelectorAll(".copilot-msg")).toHaveLength(0);
    expect(screen.queryByText("附近有两家面馆。")).not.toBeInTheDocument();
    expect(screen.queryByText("酒店附近有什么")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.getByRole("button", { name: "第二天来得及吗" })).toBeInTheDocument();
  });
});
