import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { RouteMap } from "@/components/RouteMap";

// RouteMap 在「纸上行程」重做后补的单测。钉住的是**编辑式路线条**的契约：
// 空数据不渲染、编号圆点数=站数、没有暗色底/没有正弦曲线（浅色主题不冒充
// 地理路径）、有水平基线、viewBox 宽度随站数自适应、标签不越出 viewBox。

describe("RouteMap", () => {
  const stops = [
    { name: "拙政园", type: "sight" },
    { name: "苏州博物馆", type: "sight" },
    { name: "平江路", type: "food" },
  ];
  const stationDots = (c: HTMLElement) =>
    [...c.querySelectorAll("circle")].filter((x) => x.getAttribute("r") === "12");
  const viewBox = (c: HTMLElement) =>
    (c.querySelector("svg")?.getAttribute("viewBox") ?? "").split(" ").map(Number);

  it("空 stops → 不渲染", () => {
    const { container } = render(<RouteMap stops={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("每站一个编号圆点 + 站名在", () => {
    const { container } = render(<RouteMap stops={stops} />);
    expect(stationDots(container).length).toBe(stops.length);
    for (const s of stops) expect(container.textContent).toContain(s.name);
  });

  it("浅色编辑式：没有暗色底矩形，节点用纸面色 + 强调色描边", () => {
    const { container } = render(<RouteMap stops={stops} />);
    // 浅色主题不再铺暗色底（旧版有一块 var(--surface-solid) 的 rect）
    expect(container.querySelector("rect")).toBeNull();
    const dot = stationDots(container)[0];
    expect(dot?.getAttribute("style")).toContain("var(--surface)");
    expect(dot?.getAttribute("style")).toContain("var(--accent)");
  });

  it("路线是水平基线（细线），不再画正弦曲线冒充地图", () => {
    const { container } = render(<RouteMap stops={stops} />);
    expect(container.querySelector("path")).toBeNull();
    const baseline = container.querySelector("line");
    expect(baseline).not.toBeNull();
    expect(baseline?.getAttribute("y1")).toBe(baseline?.getAttribute("y2"));
    expect(baseline?.getAttribute("style")).toContain("var(--line-strong)");
  });

  it("viewBox 宽度随站数自适应：站多则图宽（移动端更清晰）", () => {
    const { container: few } = render(<RouteMap stops={stops.slice(0, 2)} />);
    const more = [...stops, { name: "观前街", type: "shopping" }, { name: "虎丘", type: "sight" }];
    const { container: lots } = render(<RouteMap stops={more} />);
    expect(viewBox(lots)[2]).toBeGreaterThan(viewBox(few)[2]);
  });

  it("标签不越界：所有文本 y 落在 [0, H]（修顶/底裁切）", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `站点${i + 1}`, type: "sight" }));
    const { container } = render(<RouteMap stops={many} />);
    const [, , W, H] = viewBox(container);
    for (const t of container.querySelectorAll("text")) {
      const y = Number(t.getAttribute("y"));
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
    }
    expect(W).toBeGreaterThan(0);
  });
});
