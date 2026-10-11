import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PlanView } from "@/components/PlanView";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

describe("PlanView", () => {
  it("渲染行程头部：城市/天数/总价/验真状态", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getByText(`${SAMPLE_PLAN.city} · ${SAMPLE_PLAN.days.length} 天行程`)).toBeInTheDocument();
    expect(screen.getByText(/合计人均约/)).toBeInTheDocument();
    // MOCK 模式的行程：verified=false → 显示未验真标注
    expect(screen.getByText(/未接高德/)).toBeInTheDocument();
  });

  it("渲染分天卡片与景点明细（时间/名称/区域/花费）", () => {
    render(<PlanView plan={SAMPLE_PLAN} />);
    expect(screen.getByText(`Day ${SAMPLE_PLAN.days[0].day}`)).toBeInTheDocument();
    const firstSpot = SAMPLE_PLAN.days[0].spots[0];
    expect(screen.getByText(firstSpot.name)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(firstSpot.area))).toBeInTheDocument();
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
