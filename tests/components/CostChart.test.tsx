import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { CostChart } from "@/components/CostChart";

// CostChart 之前没有单测。这次重写（自适应 viewBox + 主题色变量 + 平均线夹取）
// 顺带把契约钉死：空数据不渲染、柱数=天数、标签/平均线在、色走 CSS 变量、
// viewBox 宽度随天数自适应（移动端清晰的动机）。

describe("CostChart", () => {
  const days = [
    { day: 1, dailyCostCny: 1755 },
    { day: 2, dailyCostCny: 1725 },
    { day: 3, dailyCostCny: 1555 },
  ];
  const viewBoxWidth = (c: HTMLElement) =>
    Number(c.querySelector("svg")?.getAttribute("viewBox")?.split(" ")[2] ?? 0);

  it("空 days → 不渲染", () => {
    const { container } = render(<CostChart days={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("每天一根柱 + Day 标签 + 柱顶花费", () => {
    const { container } = render(<CostChart days={days} />);
    expect(container.querySelectorAll("rect").length).toBe(days.length);
    for (const d of days) {
      expect(container.textContent).toContain(`Day ${d.day}`);
      expect(container.textContent).toContain(d.dailyCostCny.toLocaleString());
    }
  });

  it("有平均线 + 日均标签", () => {
    const { container } = render(<CostChart days={days} />);
    expect(container.querySelector("line")).not.toBeNull();
    expect(container.textContent).toMatch(/日均 ¥/);
  });

  it("色值走 CSS 变量（换主题不用改两处）", () => {
    const { container } = render(<CostChart days={days} />);
    expect(container.querySelector("rect")?.getAttribute("style")).toContain("var(--accent)");
  });

  it("viewBox 宽度随天数自适应：天数少则图窄、多则图宽", () => {
    const { container: few } = render(<CostChart days={days.slice(0, 2)} />);
    const many = Array.from({ length: 7 }, (_, i) => ({ day: i + 1, dailyCostCny: 1000 + i * 50 }));
    const { container: lots } = render(<CostChart days={many} />);
    expect(viewBoxWidth(few)).toBeLessThan(viewBoxWidth(lots));
    // 3 天图应窄于旧的固定 640（移动端缩放比更小、文字更清晰）
    expect(viewBoxWidth(few)).toBeLessThan(640);
  });

  it("单日不崩（max/avg 相同，平均线与柱顶重合也夹取在安全区）", () => {
    const { container } = render(<CostChart days={[{ day: 1, dailyCostCny: 800 }]} />);
    expect(container.querySelectorAll("rect").length).toBe(1);
    // 平均线 y 必须落在顶部留白与底部之间，不溢出画布
    const y = Number(container.querySelector("line")?.getAttribute("y1"));
    expect(y).toBeGreaterThanOrEqual(20);
    expect(y).toBeLessThanOrEqual(104);
  });
});
