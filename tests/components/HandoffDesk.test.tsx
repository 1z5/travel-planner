import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HandoffDesk } from "@/components/HandoffDesk";
import { HANDOFF_NOTICE } from "@/lib/handoff/types";

// 交接台最重要的产品红线：**全程零网络请求**。
// 这不是性能偏好，是「我们不持有你的行程」的架构证明；一旦这里出现 fetch，
// README 那句「不构成背书」就重新退化成一句免责条款。
describe("出发前交接台", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("第一屏不上传、不评分，只有粘贴入口", () => {
    render(<HandoffDesk />);
    expect(screen.getByText("把 AI 说的，变成你自己确认过的")).toBeInTheDocument();
    expect(screen.getByText(/不上传：全程在你浏览器里完成/)).toBeInTheDocument();
    expect(screen.getByText(/不评分：没有等级/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /摊开，我来签字/ })).toBeDisabled();
  });

  it("贴示例 → 逐条签字 → 生成单子 → 离线复核，全程零请求", async () => {
    const user = userEvent.setup();
    render(<HandoffDesk />);

    await user.click(screen.getByRole("button", { name: /用一段示例试试/ }));
    const summary = screen.getByRole("status");
    expect(summary).toHaveTextContent(/共 \d+ 条断言/);
    expect(summary).toHaveTextContent(/核过 0/);
    expect(screen.getAllByRole("button", { name: "我核过" }).length).toBeGreaterThan(2);

    // 默认全部「未核」，用户表态后统计才变化
    await user.click(screen.getAllByRole("button", { name: "我核过" })[0]!);
    expect(summary).toHaveTextContent(/核过 1/);

    // 依据可填，离开输入框后以 append-only 动作记入
    const basis = screen.getAllByRole("textbox", { name: /的依据/ })[0]!;
    fireEvent.change(basis, { target: { value: "官网" } });
    fireEvent.blur(basis);

    await user.click(screen.getAllByRole("button", { name: "先信着" })[1]!);
    expect(summary).toHaveTextContent(/先信着 1/);

    fireEvent.change(screen.getByLabelText("我这次决定怎么做"), {
      target: { value: "先按这版走，周一晚上重新核闭馆。" },
    });
    await user.click(screen.getByRole("button", { name: /生成交接单/ }));

    expect(screen.getByText(/^hr_[0-9a-f]{32}$/)).toBeInTheDocument();
    expect(screen.getByText(HANDOFF_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(/我的决定/)).toBeInTheDocument();
    expect(screen.getByText(/设备自述时间，我们不证明这个时刻/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "自己复核一次" }));
    expect(screen.getByText(/复核通过/)).toBeInTheDocument();

    // 关键断言：整条动线没有向服务端发过任何东西
    expect(fetch).not.toHaveBeenCalled();
  });

  it("首页粘贴框带过来的文本会自动摊开", async () => {
    window.sessionStorage.setItem(
      "tp.pending-handoff.v1",
      "第 1 天：09:00-11:00 拙政园，需提前预约；11:30-13:00 苏州博物馆，周一闭馆。",
    );
    render(<HandoffDesk />);
    expect(await screen.findByRole("status")).toHaveTextContent(/共 \d+ 条断言/);
    expect(screen.queryByRole("button", { name: /摊开，我来签字/ })).not.toBeInTheDocument();
  });

  it("不表态也能出单，单子如实写 0 条核过", async () => {
    const user = userEvent.setup();
    render(<HandoffDesk />);
    await user.click(screen.getByRole("button", { name: /用一段示例试试/ }));
    await user.click(screen.getByRole("button", { name: /生成交接单/ }));
    expect(screen.getByText(/^hr_[0-9a-f]{32}$/)).toBeInTheDocument();
    const metrics = document.querySelector(".ho-metrics");
    expect(metrics?.textContent).toContain("我核过0");
  });
});
