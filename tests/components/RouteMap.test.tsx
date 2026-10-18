import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { RouteMap } from "@/components/RouteMap";

// RouteMap 重写（暗色主题 + 移动端自适应 + 去死代码）后补的单测。钉住：
// 空数据不渲染、圆点数=站数、暗色用 var(--surface-solid)、有路径、
// viewBox 宽度随站数自适应、站名/编号标签不越出 viewBox（修裁切）。

describe("RouteMap", () => {
  const stops = [
    { name: "拙政园", type: "sight" },
    { name: "苏州博物馆", type: "sight" },
    { name: "平江路", type: "food" },
  ];
  const stationDots = (c: HTMLElement) =>
    [...c.querySelectorAll("circle")].filter((x) => x.getAttribute("r") === "11");
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

  it("暗色主题：底与圆点用 var(--surface-solid)（不再用亮蓝渐变）", () => {
    const { container } = render(<RouteMap stops={stops} />);
    expect(container.querySelector("rect")?.getAttribute("style")).toContain("var(--surface-solid)");
    expect(stationDots(container)[0]?.getAttribute("style")).toContain("var(--surface-solid)");
  });

  it("有平滑路线路径", () => {
    const { container } = render(<RouteMap stops={stops} />);
    const path = container.querySelector("path");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")).toMatch(/^M .* C /); // 含三次贝塞尔
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
