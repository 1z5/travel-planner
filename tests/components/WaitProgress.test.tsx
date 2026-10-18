import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { WaitProgress } from "@/components/WaitProgress";

// 等待进度条：核心是「诚实」——有确切进度才画确定性宽度，否则不确定动画，
// 不假装百分比。这三条把这两种态和 meta 展示钉死。

describe("WaitProgress", () => {
  it("确定性进度：pct 有值 → 对应宽度 + aria-valuenow，无动画类", () => {
    const { container } = render(<WaitProgress pct={50} elapsed="1:20" detail="已生成 3/5 天" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    const fill = container.querySelector(".wait-bar-fill");
    expect(fill).not.toHaveClass("indeterminate");
    expect(fill?.getAttribute("style")).toContain("width: 50%");
  });

  it("不确定进度：pct=null → 动画类、不设宽度、无 aria-valuenow（不假装百分比）", () => {
    const { container } = render(<WaitProgress pct={null} elapsed="0:30" />);
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    const fill = container.querySelector(".wait-bar-fill");
    expect(fill).toHaveClass("indeterminate");
    expect(fill?.getAttribute("style")).toBeNull();
  });

  it("meta：显示已等待 + 有 detail 才显示天数，无 detail 不显示", () => {
    const { container, rerender } = render(
      <WaitProgress pct={40} elapsed="2:05" detail="已生成 2/5 天" />,
    );
    const meta = container.querySelector(".wait-meta");
    expect(meta?.textContent).toContain("2:05");
    expect(meta?.textContent).toContain("已生成 2/5 天");
    rerender(<WaitProgress pct={null} elapsed="0:10" />);
    const meta2 = container.querySelector(".wait-meta");
    expect(meta2?.textContent).toContain("0:10");
    expect(meta2?.textContent).not.toContain("已生成");
  });
});
