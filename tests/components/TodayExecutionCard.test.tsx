import { beforeEach, describe, expect, it, vi } from "vitest";

// 打卡埋点：断言「用户点了」才上报，不拿页面打开冒充到达。
vi.mock("@/lib/track", () => ({ track: vi.fn() }));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TodayExecutionCard } from "@/components/TodayExecutionCard";
import { track } from "@/lib/track";
import type { PlanLeg, PlanSpot } from "@/lib/types";
import type { SpotNow } from "@/lib/trip-day";

const mockedTrack = vi.mocked(track);

function spot(name: string, time: string): PlanSpot {
  return {
    period: "morning",
    time,
    type: "sight",
    name,
    area: "青羊区",
    durationMin: 90,
    costCny: 60,
    reason: "测试点位",
  };
}

const SPOTS = [spot("宽窄巷子", "08:00-10:00"), spot("陈麻婆豆腐", "10:30-12:00")];
const LEGS: PlanLeg[] = [
  {
    from: "宽窄巷子",
    to: "陈麻婆豆腐",
    mode: "walking",
    distanceM: 500,
    durationSec: 420,
    steps: [],
  },
];

beforeEach(() => {
  window.localStorage.clear();
  mockedTrack.mockClear();
});

describe("TodayExecutionCard", () => {
  it("下一站 + 真实路段 → 给出建议出发时间（开始 - 通勤 - 缓冲）", () => {
    const status: SpotNow = { kind: "next", index: 1 };
    render(
      <TodayExecutionCard
        shareId="share_t"
        city="成都"
        dayNo={1}
        status={status}
        spots={SPOTS}
        legs={LEGS}
        nowMinutes={8 * 60}
      />,
    );
    // 下一站 10:30 开始；步行 7 分钟 + 缓冲 5 分钟 → 10:18 出发
    expect(screen.getByText("下一站")).toBeInTheDocument();
    expect(screen.getByText("陈麻婆豆腐")).toBeInTheDocument();
    expect(screen.getByText("10:18")).toBeInTheDocument();
    expect(screen.getByText(/步行 7 分钟 \+ 5 分钟缓冲/)).toBeInTheDocument();
  });

  it("没有真实路段 → 明说「无法建议」，不拿估算值凑一个时间", () => {
    const status: SpotNow = { kind: "next", index: 1 };
    render(
      <TodayExecutionCard
        shareId="share_t"
        city="成都"
        dayNo={1}
        status={status}
        spots={SPOTS}
        legs={[]}
        nowMinutes={8 * 60}
      />,
    );
    expect(screen.getByText("通勤数据缺失，无法建议出发时间")).toBeInTheDocument();
    // 按钮仍然可用（用户仍可以打卡，只是没有时间建议）
    expect(screen.getByRole("button", { name: /标记已出发/ })).toBeInTheDocument();
  });

  it("点「我已到达」→ 埋点 today_arrived + 按钮变完成态（不重复计次）", async () => {
    const status: SpotNow = { kind: "next", index: 1 };
    render(
      <TodayExecutionCard
        shareId="share_t"
        city="成都"
        dayNo={1}
        status={status}
        spots={SPOTS}
        legs={LEGS}
        nowMinutes={8 * 60}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /标记已到达/ }));
    expect(mockedTrack).toHaveBeenCalledWith("today_arrived", {
      shareId: "share_t",
      city: "成都",
      day: 1,
    });
    expect(screen.getByText("已到达")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /我已到达/ })).not.toBeInTheDocument();
  });

  it("点「我已出发」→ 埋点 today_departed + 按钮变「已出发」并禁用", async () => {
    const status: SpotNow = { kind: "next", index: 1 };
    render(
      <TodayExecutionCard
        shareId="share_t"
        city="成都"
        dayNo={1}
        status={status}
        spots={SPOTS}
        legs={LEGS}
        nowMinutes={8 * 60}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /标记已出发/ }));
    expect(mockedTrack).toHaveBeenCalledWith("today_departed", {
      shareId: "share_t",
      city: "成都",
      day: 1,
    });
    expect(screen.getByRole("button", { name: /标记已出发/ })).toBeDisabled();
  });

  it("今天已结束/无状态 → 不渲染卡片（没有下一站就不编）", () => {
    const { container } = render(
      <TodayExecutionCard
        shareId="share_t"
        city="成都"
        dayNo={1}
        status={{ kind: "done" }}
        spots={SPOTS}
        legs={LEGS}
        nowMinutes={23 * 60}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
