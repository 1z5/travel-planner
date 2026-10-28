import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DemoReadOnlyNote } from "@/components/DemoReadOnlyNote";
import { SAMPLE_PLAN } from "@/lib/sample-plan";

// 演示行程只读提示：组件自己做 plan.demo 判断（非 demo 返回 null），
// 保证 Lead 可以在分享页/工作台无条件挂载而不改变现有页面。

const demoPlan = { ...SAMPLE_PLAN, demo: true };

describe("DemoReadOnlyNote", () => {
  it("demo 行程：说明写操作已关闭，并给「去分享页克隆」引导", () => {
    render(<DemoReadOnlyNote plan={demoPlan} shareId="share_demo01" />);

    expect(screen.getByRole("note", { name: "示例行程只读提示" })).toBeInTheDocument();
    expect(screen.getByText("示例行程 · 只读")).toBeInTheDocument();
    expect(
      screen.getByText(/写操作（调整顺序 \/ 重排时间 \/ 确定性修复）已关闭/),
    ).toBeInTheDocument();
    expect(screen.getByText(/克隆成你的行程后即可编辑/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /去分享页克隆/ })).toHaveAttribute(
      "href",
      "/p/share_demo01",
    );
  });

  it("share 变体：不链回自己，提示同页的克隆入口", () => {
    render(<DemoReadOnlyNote plan={demoPlan} variant="share" />);

    expect(screen.getByRole("note", { name: "示例行程只读提示" })).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/本页「克隆成我的行程」/)).toBeInTheDocument();
  });

  it("非 demo 行程：整块不渲染（不改现有页面）", () => {
    const { container } = render(<DemoReadOnlyNote plan={SAMPLE_PLAN} shareId="share_x" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("demo 缺省（非 true）也按可编辑处理", () => {
    const { container } = render(
      <DemoReadOnlyNote plan={{ ...SAMPLE_PLAN, demo: undefined }} shareId="share_x" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
