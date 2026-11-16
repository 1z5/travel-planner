import { describe, expect, it } from "vitest";
import { distMeters, fmtDist, haversineMeters, parseLngLat } from "@/lib/geo/spatial";

// spatial.ts 是全项目空间算术的唯一来源（ADR-020 · R5）。高德 POI 坐标
// 与「我离这站多远」必须给出同一个距离。

describe("parseLngLat", () => {
  it("合法坐标解析为 [lng, lat]", () => {
    expect(parseLngLat("104.06,30.57")).toEqual([104.06, 30.57]);
    expect(parseLngLat(" 116.481 , 39.989 ")).toEqual([116.481, 39.989]);
  });

  it("空/格式错/缺段/多段 → null（不猜坐标）", () => {
    expect(parseLngLat(undefined)).toBeNull();
    expect(parseLngLat("")).toBeNull();
    expect(parseLngLat("abc")).toBeNull();
    expect(parseLngLat("104.06")).toBeNull(); // 缺纬度
    expect(parseLngLat("104.06,30.57,99")).toBeNull(); // 多一段
  });
});

describe("haversineMeters（数值核心）", () => {
  it("同一点 → 0", () => {
    expect(haversineMeters([104.06, 30.57], [104.06, 30.57])).toBe(0);
  });

  it("对称：haversine(a,b) === haversine(b,a)", () => {
    expect(haversineMeters([104.06, 30.57], [104.2, 30.8])).toBe(
      haversineMeters([104.2, 30.8], [104.06, 30.57]),
    );
  });

  it("赤道上一经度 ≈ 111km（量级校准）", () => {
    const d = haversineMeters([0, 0], [1, 0]);
    expect(d).toBeGreaterThan(110000);
    expect(d).toBeLessThan(112000);
  });
});

describe("distMeters 地表距离（haversine，字符串 API）", () => {
  it("同一点 → 0", () => {
    expect(distMeters("104.06,30.57", "104.06,30.57")).toBe(0);
  });

  it("短距离为正且量级合理（成都两点约 1-2 公里）", () => {
    const d = distMeters("104.06,30.57", "104.07,30.58");
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(500);
    expect(d!).toBeLessThan(3000);
  });

  it("越远的点距离越大", () => {
    const near = distMeters("104.06,30.57", "104.07,30.58")!;
    const far = distMeters("104.06,30.57", "104.20,30.80")!;
    expect(far).toBeGreaterThan(near);
  });

  it("解析失败 → null，不编距离", () => {
    expect(distMeters(undefined, "104.06,30.57")).toBeNull();
    expect(distMeters("abc", "104.06,30.57")).toBeNull();
    expect(distMeters("104.06", "104.06,30.57")).toBeNull();
  });
});

describe("fmtDist 距离格式化", () => {
  it("小于 1 公里用米", () => {
    expect(fmtDist(0)).toBe("0 米");
    expect(fmtDist(500)).toBe("500 米");
    expect(fmtDist(999)).toBe("999 米");
  });

  it("满 1 公里用公里（一位小数）", () => {
    expect(fmtDist(1000)).toBe("1.0 公里");
    expect(fmtDist(1500)).toBe("1.5 公里");
    expect(fmtDist(28500)).toBe("28.5 公里");
  });
});
