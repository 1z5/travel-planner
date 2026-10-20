import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RealMap, type RealMapPoint } from "@/components/RealMap";

// RealMap：真实地图底图 + 自绘覆盖层。
//
// jsdom 没有 IntersectionObserver / clientWidth，所以两个浏览器 API 都在这里
// 打桩。钉住的契约：
// 1. 坐标不足 2 个绝不请求底图 → fallback（不假装有地图）；
// 2. 只有进入视口附近才发 /api/map 请求（懒加载，保护高德 QPS）；
// 3. 覆盖层编号数量 = 有效站点数，站名截断且标签不越界；
// 4. img onError → fallback（页面里不能出现破图）。

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  options?: IntersectionObserverInit;
  private callback: IntersectionObserverCallback;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = () => [];
  root = null;
  rootMargin = "0px";
  thresholds = [0];

  constructor(cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = cb;
    this.options = options;
    FakeIntersectionObserver.instances.push(this);
  }

  trigger(isIntersecting = true): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const POINTS: RealMapPoint[] = [
  { name: "武侯祠", type: "sight", location: "104.048,30.645" },
  { name: "锦里", type: "food", location: "104.049,30.643" },
  { name: "宽窄巷子", type: "activity", location: "104.055,30.663" },
];

/** 触发最近创建的 IntersectionObserver（模拟进入视口） */
function enterViewport(isIntersecting = true): void {
  const io = FakeIntersectionObserver.instances.at(-1);
  if (!io) throw new Error("组件没有创建 IntersectionObserver");
  act(() => io.trigger(isIntersecting));
}

describe("RealMap 降级契约", () => {
  it("合法坐标不足 2 个 → 渲染传入的 fallback，不发图片请求", () => {
    const { container, getByText } = render(
      <RealMap
        points={[
          { name: "武侯祠", type: "sight", location: "104.048,30.645" },
          { name: "锦里", type: "food" }, // 未验真：没有坐标
          { name: "宽窄巷子", type: "activity", location: "bad-loc" },
        ]}
        fallback={<div>示意图降级</div>}
      />,
    );
    expect(getByText("示意图降级")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    // 坐标不足时连观察器都不该创建（不占资源）
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it("可用坐标超过 10 个 → 直接降级，不发注定 400 的请求", () => {
    // /api/map 的上限是 10 个点位；超过时服务端会 400，前端应提前降级并说明原因
    const many = Array.from({ length: 11 }, (_, i) => ({
      name: `站点${i + 1}`,
      type: "sight",
      location: `${(103.9 + i * 0.01).toFixed(2)},30.60`,
    }));
    const { container, getByText } = render(
      <RealMap points={many} fallback={<div>示意图降级</div>} />,
    );
    expect(getByText("示意图降级")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it("没有传 fallback 时渲染内置的诚实提示（不说假话）", () => {
    const { getByText } = render(
      <RealMap points={[{ name: "武侯祠", type: "sight", location: "104.048,30.645" }]} />,
    );
    expect(getByText(/坐标不足 2 个/)).toBeInTheDocument();
  });

  it("底图请求失败（img onError）→ 渲染 fallback，不留破图", () => {
    const { container, getByText } = render(
      <RealMap points={POINTS} fallback={<div>示意图降级</div>} />,
    );
    enterViewport();
    const img = container.querySelector("img.realmap-img");
    expect(img).not.toBeNull();
    fireEvent.error(img!);
    expect(getByText("示意图降级")).toBeInTheDocument();
    expect(container.querySelector("img.realmap-img")).toBeNull();
  });

  it("站点变化后自动重试：一次加载失败不会被永久固化", () => {
    const { container, rerender } = render(
      <RealMap points={POINTS} fallback={<div>示意图降级</div>} />,
    );
    enterViewport();
    fireEvent.error(container.querySelector("img.realmap-img")!);
    expect(container.textContent).toContain("示意图降级");

    // 改行程换了站点（数量不变、坐标变了）→ 新 URL 应重新尝试加载
    rerender(
      <RealMap
        points={[
          { name: "人民公园", type: "sight", location: "104.06,30.65" },
          POINTS[1],
          POINTS[2],
        ]}
        fallback={<div>示意图降级</div>}
      />,
    );
    const img = container.querySelector("img.realmap-img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toContain("104.06,30.65");
  });
});

describe("RealMap 懒加载", () => {
  it("进入视口前不渲染 img、只渲染固定宽高比骨架；rootMargin=200px", () => {
    const { container } = render(<RealMap points={POINTS} label="第 1 天" />);
    expect(container.querySelector("img.realmap-img")).toBeNull();
    const skeleton = container.querySelector("svg.realmap-skeleton");
    expect(skeleton).not.toBeNull();
    expect(skeleton?.getAttribute("viewBox")).toBe("0 0 720 400");
    // 懒加载触发距离：200px（行程页可能同时有 10 天，不能全部提前请求）
    expect(FakeIntersectionObserver.instances.at(-1)?.options?.rootMargin).toBe("200px");
    expect(container.querySelector("svg.realmap-overlay")).toBeNull();
  });

  it("进入视口后渲染 img，src 指向 /api/map 且带 loc/w/h/scale", () => {
    const { container } = render(<RealMap points={POINTS} label="第 1 天" />);
    enterViewport();

    const img = container.querySelector<HTMLImageElement>("img.realmap-img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src") ?? "";
    expect(src.startsWith("/api/map?")).toBe(true);
    expect(src).toContain("loc=104.048,30.645;104.049,30.643;104.055,30.663");
    expect(src).toContain("w=720");
    expect(src).toContain("h=400");
    expect(src).toContain("scale=2");
    // 图片原始比例由 width/height 属性预留，避免加载后布局跳动
    expect(img!.getAttribute("width")).toBe("720");
    expect(img!.getAttribute("height")).toBe("400");
    expect(container.querySelector("svg.realmap-skeleton")).toBeNull();
  });

  it("环境没有 IntersectionObserver 时直接加载（不白屏）", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { container } = render(<RealMap points={POINTS} />);
    expect(container.querySelector("img.realmap-img")).not.toBeNull();
  });
});

describe("RealMap 覆盖层", () => {
  it("编号圆点数量 = 有效站点数，编号 1..N，站名都在", () => {
    const { container } = render(<RealMap points={POINTS} label="第 2 天" />);
    enterViewport();
    const stops = container.querySelectorAll("circle.realmap-stop");
    expect(stops).toHaveLength(POINTS.length);
    const text = container.textContent ?? "";
    for (let i = 1; i <= POINTS.length; i++) expect(text).toContain(String(i));
    for (const p of POINTS) expect(text).toContain(p.name);
    // 路线连线（accent 虚线）
    expect(container.querySelector("polyline.realmap-route")).not.toBeNull();
  });

  it("语义色沿用 RouteMap：景点 #38bdf8 / 餐饮 #fbbf24 / 体验 #34d399", () => {
    const { container } = render(<RealMap points={POINTS} />);
    enterViewport();
    const stops = [...container.querySelectorAll("circle.realmap-stop")];
    expect(stops[0]?.getAttribute("stroke")).toBe("#38bdf8");
    expect(stops[1]?.getAttribute("stroke")).toBe("#fbbf24");
    expect(stops[2]?.getAttribute("stroke")).toBe("#34d399");
  });

  it("非法坐标被过滤，但合法点仍上图（不因一站缺坐标作废整张图）", () => {
    const { container } = render(
      <RealMap
        points={[
          ...POINTS,
          { name: "没坐标的店", type: "food" },
          { name: "坐标非法", type: "sight", location: "oops" },
        ]}
      />,
    );
    enterViewport();
    expect(container.querySelectorAll("circle.realmap-stop")).toHaveLength(3);
    expect(container.querySelector(".realmap")?.getAttribute("aria-label")).toBe(
      "真实路线地图，共 3 站",
    );
  });

  it("无障碍：容器 role=img + aria-label（第 N 天，共 K 站）", () => {
    const { container } = render(<RealMap points={POINTS} label="第 1 天" />);
    enterViewport();
    const box = container.querySelector(".realmap");
    expect(box?.getAttribute("role")).toBe("img");
    expect(box?.getAttribute("aria-label")).toBe("第 1 天真实路线地图，共 3 站");
  });

  it("长站名截断到 9 字（8 字 + …），不留全文", () => {
    const longName = "这是一个非常长的景点名称";
    const { container } = render(
      <RealMap
        points={[{ name: longName, type: "sight", location: "104.048,30.645" }, POINTS[1]]}
      />,
    );
    enterViewport();
    const labels = [...container.querySelectorAll("text.realmap-label")].map(
      (t) => t.textContent ?? "",
    );
    expect(labels[0]).toBe("这是一个非常长的…");
    expect(labels.join("")).not.toContain(longName);
  });

  it("所有标签（编号/站名）坐标都落在 viewBox 内（贴边不裁切）", () => {
    // 六个站点铺开，确保左右边缘都有关键点
    const spread: RealMapPoint[] = [
      { name: "西岭雪山", type: "sight", location: "103.33,30.68" },
      { name: "都江堰", type: "sight", location: "103.62,31.0" },
      { name: "青城山", type: "sight", location: "103.57,30.89" },
      { name: "宽窄巷子", type: "activity", location: "104.055,30.663" },
      { name: "春熙路", type: "shopping", location: "104.08,30.66" },
      { name: "天府广场", type: "transport", location: "104.066,30.657" },
    ];
    const { container } = render(<RealMap points={spread} />);
    enterViewport();
    const w = Number(container.querySelector("img.realmap-img")?.getAttribute("width"));
    const h = Number(container.querySelector("img.realmap-img")?.getAttribute("height"));
    const texts = [...container.querySelectorAll("svg.realmap-overlay text")];
    expect(texts.length).toBeGreaterThanOrEqual(spread.length);
    for (const t of texts) {
      const x = Number(t.getAttribute("x"));
      const y = Number(t.getAttribute("y"));
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(w);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(h);
    }
  });

  it("className 透传到地图容器（供集成方微调布局）", () => {
    const { container } = render(<RealMap points={POINTS} className="realmap-day1" />);
    enterViewport();
    const box = container.querySelector(".realmap");
    expect(box?.classList.contains("realmap")).toBe(true);
    expect(box?.classList.contains("realmap-day1")).toBe(true);
  });
});
