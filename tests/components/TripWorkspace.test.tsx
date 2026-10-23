import { describe, expect, it, vi } from "vitest";

// CloneCTA 用 useRouter 做克隆后跳转——jsdom 里没有 App Router 上下文
let searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => searchParams,
}));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TripWorkspace } from "@/components/TripWorkspace";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// Trip Workspace：一个行程三个镜头。这里只钉「壳」的契约——镜头可切换、
// 默认在规划、地图镜头按天给点位、今日镜头渲染行中视图。
// PlanView/TodayView 自身的行为由它们各自的测试覆盖。

describe("Trip Workspace", () => {
  it("默认进入规划镜头，Header 带城市/天数/核验状态", () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    expect(
      screen.getByRole("heading", { level: 1, name: `${SAMPLE_PLAN.city} · 3 天行程` }),
    ).toBeInTheDocument();
    // SAMPLE_PLAN 没有 verification 字段：不谎称已核验
    expect(screen.getByText("核验状态未知")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /规划/ })).toHaveAttribute("aria-selected", "true");
  });

  it("切到地图镜头：可按天切换，并列出当天点位", async () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);

    await userEvent.click(screen.getByRole("tab", { name: /地图/ }));
    expect(screen.getByRole("tab", { name: /地图/ })).toHaveAttribute("aria-selected", "true");

    // 默认第 1 天：列表里应出现第 1 天的点位（地图降级示意图也会渲染站名，
    // 所以用 getAllByText 而不是 getByText）
    expect(screen.getAllByText("拙政园").length).toBeGreaterThan(0);

    // 切到第 3 天：出现第 3 天的点位（同里古镇）
    await userEvent.click(screen.getByRole("button", { name: /Day 3/ }));
    expect(screen.getAllByText("同里古镇").length).toBeGreaterThan(0);
  });

  it("切到今日镜头：渲染行中模式", async () => {
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    await userEvent.click(screen.getByRole("tab", { name: /今日/ }));
    expect(screen.getAllByText("行中模式").length).toBeGreaterThan(0);
  });

  it("深链 ?view=map 直接落到地图镜头（不执行自动 heuristic）", () => {
    searchParams = new URLSearchParams("view=map");
    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    expect(screen.getByRole("tab", { name: /地图/ })).toHaveAttribute("aria-selected", "true");
    searchParams = new URLSearchParams();
  });

  it("复制链接：写入剪贴板并反馈已复制", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<TripWorkspace plan={SAMPLE_PLAN} shareId="share_ws01" />);
    await userEvent.click(screen.getByRole("button", { name: /复制链接/ }));

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain("/p/share_ws01");
    expect(await screen.findByText("已复制")).toBeInTheDocument();
  });
});
