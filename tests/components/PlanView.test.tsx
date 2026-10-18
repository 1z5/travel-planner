import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "@/components/PlanView";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import { localTodayIso } from "@/lib/trip-day";

describe("PlanView", () => {
  it("渲染行程头部：城市/天数/总价/验真状态", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getByText(`${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`)).toBeInTheDocument();
    expect(screen.getByText(/人均总花费/)).toBeInTheDocument();
    // MOCK 模式的行程：verified=false → 显示未验真标注
    expect(screen.getByText(/未接高德/)).toBeInTheDocument();
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
      expect(screen.getByText(new RegExp(`行程体检发现 ${SAMPLE_PLAN.warnings.length} 个问题`))).toBeInTheDocument();
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

  it("雨天备选标注渲染", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    const withBackup = SAMPLE_PLAN.days.flatMap((d) => d.spots).find((s) => s.rainBackup);
    if (withBackup) {
      expect(screen.getByText(new RegExp(`雨天备选：${withBackup.rainBackup}`.slice(0, 12)))).toBeInTheDocument();
    }
  });

  it("分享按钮只在提供 shareId 时出现", () => {
    const { rerender } = render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.queryByText("复制分享链接")).not.toBeInTheDocument();
    expect(screen.queryByText(/下载日历/)).not.toBeInTheDocument();

    rerender(<PlanView plan={SAMPLE_PLAN} shareId="job_test123" />);
    expect(screen.getByText("复制分享链接")).toBeInTheDocument();
    expect(screen.getByText("下载日历（.ics）")).toHaveAttribute("href", "/api/plan/ics?id=job_test123");
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
});
