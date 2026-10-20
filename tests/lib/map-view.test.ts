import { describe, expect, it } from "vitest";
import {
  DEFAULT_CENTER,
  DEFAULT_ZOOM,
  MAX_MERCATOR_LAT,
  MAX_ZOOM,
  MIN_ZOOM,
  SINGLE_POINT_ZOOM,
  fitView,
  isValidPoint,
  mercator,
  parseLocText,
  projectPixels,
  type MapPoint,
} from "@/lib/map-view";

// 真实地图覆盖层的「对齐地基」单测。
//
// 钉住的核心不变量：
// 1. fitView 算出的 center/zoom 与高德静态地图的 location/zoom 语义一致；
// 2. projectPixels 用同一套 Web Mercator 数学，拟合后的点必须落在画布内
//    （否则自绘标记会从底图上漂走/被裁掉）；
// 3. 脏坐标绝不抛错、绝不产出 NaN —— 渲染路径上抛错会整页白屏。

const CHENGDU: MapPoint[] = [
  { lng: 104.07, lat: 30.6 },
  { lng: 104.02, lat: 30.55 },
  { lng: 104.05, lat: 30.58 },
];

describe("mercator（Web Mercator 投影）", () => {
  it("(0,0) 是归一化世界坐标中心 (0.5,0.5)", () => {
    const m = mercator(0, 0);
    expect(m.x).toBeCloseTo(0.5, 12);
    expect(m.y).toBeCloseTo(0.5, 12);
  });

  it("经度 180 → x=1；纬度上限 → y≈0（北在上，屏幕坐标系向下）", () => {
    expect(mercator(180, 0).x).toBeCloseTo(1, 12);
    expect(mercator(-180, 0).x).toBeCloseTo(0, 12);
    expect(mercator(0, MAX_MERCATOR_LAT).y).toBeCloseTo(0, 6);
    expect(mercator(0, -MAX_MERCATOR_LAT).y).toBeCloseTo(1, 6);
  });

  it("纬度超出 Mercator 上限时夹取，不产生 Infinity/NaN（底图不会整块失效）", () => {
    const a = mercator(0, 89);
    const b = mercator(0, MAX_MERCATOR_LAT);
    expect(a.x).toBe(b.x);
    expect(a.y).toBeCloseTo(b.y, 12);
    expect(Number.isFinite(mercator(0, 90).y)).toBe(true);
  });

  it("经度增大 x 单调增大", () => {
    expect(mercator(104.1, 30).x).toBeGreaterThan(mercator(104.0, 30).x);
  });
});

describe("fitView（视野拟合）", () => {
  it("成都三个点：中心在 bbox 中心附近、整数 zoom 在 [10,16]", () => {
    const view = fitView(CHENGDU, 720, 400);
    expect(view.center.lng).toBeCloseTo(104.045, 3);
    expect(view.center.lat).toBeCloseTo(30.575, 3);
    expect(Number.isInteger(view.zoom)).toBe(true);
    expect(view.zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(view.zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it("默认 padding=36 时所有点投影都落在画布内（含留白）", () => {
    const view = fitView(CHENGDU, 720, 400);
    const pixels = projectPixels(CHENGDU, view, 720, 400);
    for (const p of pixels) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(720);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(400);
      // 留白也应生效：不贴边（给编号圆点/站名留空间）
      expect(p.x).toBeGreaterThanOrEqual(36 - 1e-6);
      expect(p.x).toBeLessThanOrEqual(720 - 36 + 1e-6);
      expect(p.y).toBeGreaterThanOrEqual(36 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(400 - 36 + 1e-6);
    }
  });

  it("单点：固定 zoom=14 且以该点为中心（没有 bbox 可拟合）", () => {
    const view = fitView([CHENGDU[0]], 720, 400);
    expect(view.zoom).toBe(SINGLE_POINT_ZOOM);
    expect(view.center.lng).toBeCloseTo(CHENGDU[0].lng, 10);
    expect(view.center.lat).toBeCloseTo(CHENGDU[0].lat, 10);
  });

  it("所有点重合：同样按单点处理（zoom=14，不出现 NaN）", () => {
    const shared: MapPoint[] = [
      { lng: 104.0665, lat: 30.5728 },
      { lng: 104.0665, lat: 30.5728 },
      { lng: 104.0665, lat: 30.5728 },
    ];
    const view = fitView(shared, 720, 400);
    expect(view.zoom).toBe(SINGLE_POINT_ZOOM);
    expect(view.center.lng).toBeCloseTo(104.0665, 10);
  });

  it("空数组 / 全是非法坐标：返回成都默认中心，不抛错", () => {
    for (const points of [
      [],
      [
        { lng: NaN, lat: 30 },
        { lng: 104, lat: Infinity },
      ] as MapPoint[],
    ]) {
      const view = fitView(points, 720, 400);
      expect(view.center.lng).toBeCloseTo(DEFAULT_CENTER.lng, 10);
      expect(view.center.lat).toBeCloseTo(DEFAULT_CENTER.lat, 10);
      expect(view.zoom).toBe(DEFAULT_ZOOM);
    }
  });

  it("混入非法坐标时只按合法点拟合（一站坐标缺失不拖垮整张图）", () => {
    const view = fitView([CHENGDU[0], { lng: NaN, lat: 0 }, CHENGDU[1]], 720, 400);
    const normal = fitView([CHENGDU[0], CHENGDU[1]], 720, 400);
    expect(view).toEqual(normal);
  });

  it("跨半球/极端坐标：zoom 夹到 10，中心与投影仍是有限数", () => {
    const view = fitView(
      [
        { lng: -180, lat: -85 },
        { lng: 180, lat: 85 },
      ],
      720,
      400,
    );
    expect(view.zoom).toBe(MIN_ZOOM);
    expect(Number.isFinite(view.center.lng)).toBe(true);
    expect(Number.isFinite(view.center.lat)).toBe(true);
    const pixels = projectPixels(
      [
        { lng: -180, lat: -85 },
        { lng: 180, lat: 85 },
      ],
      view,
      720,
      400,
    );
    for (const p of pixels) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("紧挨着的两个点：zoom 不超过上限 16（不能无限放大）", () => {
    const view = fitView(
      [
        { lng: 104.0665, lat: 30.5728 },
        { lng: 104.067, lat: 30.5731 },
      ],
      720,
      400,
    );
    expect(view.zoom).toBe(MAX_ZOOM);
  });

  it("padding 越大，可容纳的 zoom 越小（或持平）", () => {
    const tight = fitView(CHENGDU, 720, 400, 0);
    const loose = fitView(CHENGDU, 720, 400, 160);
    expect(loose.zoom).toBeLessThanOrEqual(tight.zoom);
  });

  it("宽高非法（0/NaN）时回退到 720×400 语义，不抛错", () => {
    const view = fitView(CHENGDU, 0, NaN);
    expect(Number.isInteger(view.zoom)).toBe(true);
    expect(Number.isFinite(view.center.lng)).toBe(true);
  });
});

describe("projectPixels（覆盖层像素投影）", () => {
  it("视野中心点投影到画布正中（覆盖层与底图的锚点一致）", () => {
    const view = fitView(CHENGDU, 720, 400);
    const [p] = projectPixels([view.center], view, 720, 400);
    expect(p.x).toBeCloseTo(360, 6);
    expect(p.y).toBeCloseTo(200, 6);
  });

  it("与 tile 数学一致：zoom=10 时 1 经度 = 256*2^10/360 像素", () => {
    const view = { center: { lng: 0, lat: 0 }, zoom: 10 };
    const [center, east] = projectPixels(
      [
        { lng: 0, lat: 0 },
        { lng: 1, lat: 0 },
      ],
      view,
      720,
      400,
    );
    expect(center.x).toBeCloseTo(360, 6);
    expect(center.y).toBeCloseTo(200, 6);
    expect(east.x).toBeCloseTo(360 + (256 * 2 ** 10) / 360, 6);
    expect(east.y).toBeCloseTo(200, 6);
  });

  it("zoom 每 +1，同一经度差对应的像素距离翻倍", () => {
    const at10 = projectPixels(
      [
        { lng: 0, lat: 0 },
        { lng: 0.01, lat: 0 },
      ],
      { center: { lng: 0, lat: 0 }, zoom: 10 },
      720,
      400,
    );
    const at11 = projectPixels(
      [
        { lng: 0, lat: 0 },
        { lng: 0.01, lat: 0 },
      ],
      { center: { lng: 0, lat: 0 }, zoom: 11 },
      720,
      400,
    );
    expect(at11[1].x - at11[0].x).toBeCloseTo((at10[1].x - at10[0].x) * 2, 6);
  });

  it("北边的点 y 更小（屏幕上方就是北方）", () => {
    const view = { center: { lng: 104, lat: 30 }, zoom: 12 };
    const [south, north] = projectPixels(
      [
        { lng: 104, lat: 30.01 },
        { lng: 104, lat: 30.02 },
      ],
      view,
      720,
      400,
    );
    expect(north.y).toBeLessThan(south.y);
  });

  it("空点集返回空数组", () => {
    expect(projectPixels([], { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM }, 720, 400)).toEqual([]);
  });
});

describe("parseLocText（高德 location 字段解析）", () => {
  it('合法 "lng,lat"（含负数、空白）', () => {
    expect(parseLocText("104.0665,30.5728")).toEqual({ lng: 104.0665, lat: 30.5728 });
    expect(parseLocText(" -122.4194 , 37.7749 ")).toEqual({ lng: -122.4194, lat: 37.7749 });
    expect(parseLocText("0,0")).toEqual({ lng: 0, lat: 0 });
  });

  it("非法输入一律 null（绝不猜一个坐标出来）", () => {
    const bad = [
      undefined,
      null,
      "",
      " ",
      "104.07",
      "104.07,30.60,1",
      "104.07,",
      ",30.60",
      "abc,30",
      "104.07,abc",
      "NaN,30",
      "Infinity,30",
      "104.07,NaN",
      "181,30", // 经度越界
      "104.07,86", // 纬度超出 Mercator 上限
      "104.07;30.60", // 分隔符错（分号是点集分隔符）
    ] as const;
    for (const loc of bad) expect(parseLocText(loc)).toBeNull();
  });

  it("坐标范围边界（±180 经度 / ±Mercator 纬度上限）是合法的", () => {
    expect(parseLocText(`180,${MAX_MERCATOR_LAT}`)).not.toBeNull();
  });
});

describe("isValidPoint", () => {
  it("有限数且在合法范围才为 true", () => {
    expect(isValidPoint({ lng: 104, lat: 30 })).toBe(true);
    expect(isValidPoint({ lng: NaN, lat: 30 })).toBe(false);
    expect(isValidPoint({ lng: 104, lat: Infinity })).toBe(false);
    expect(isValidPoint({ lng: 181, lat: 30 })).toBe(false);
    expect(isValidPoint(null)).toBe(false);
    expect(isValidPoint(undefined)).toBe(false);
  });
});
