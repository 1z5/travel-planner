import { describe, expect, it, vi, afterEach } from "vitest";
import { buildWeatherAdvice, fetchWeather } from "@/lib/weather";
import type { Plan } from "@/lib/types";

// 天气规划的两个核心原则必须钉死：
// 1. **只提示不改写**——完全不碰 plan.days，只在 warnings 里加提示
// 2. **查不到就不猜**——高德预报只有 4 天窗口，超出窗口绝不能编造天气
// （把「不知道」说成「晴天」和把「服务异常」说成「景点不存在」是同一类错误）

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    city: "成都",
    startDate: "2026-10-16",
    summary: "测试行程",
    days: [
      {
        day: 1,
        theme: "市区",
        spots: [
          { period: "morning", time: "09:00-11:00", type: "sight", name: "武侯祠", area: "武侯区", durationMin: 120, costCny: 50, reason: "test" },
          { period: "lunch", time: "12:00-13:00", type: "food", name: "餐厅", area: "武侯区", durationMin: 60, costCny: 50, reason: "test" },
        ],
        transitMin: 20,
        dailyCostCny: 100,
      },
    ],
    totalCostCny: 100,
    tips: [],
    warnings: [],
    verified: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWeather", () => {
  it("MOCK 模式（未配 key）返回 unavailable，不假装有天气", async () => {
    const saved = process.env.AMAP_WEB_SERVICE_KEY;
    delete process.env.AMAP_WEB_SERVICE_KEY;
    vi.resetModules();
    const { fetchWeather } = await import("@/lib/weather");
    const r = await fetchWeather("成都");
    expect(r.state).toBe("unavailable");
    if (saved !== undefined) process.env.AMAP_WEB_SERVICE_KEY = saved;
  });

  it("正常返回：解析预报为按天的结构化数据", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        status: "1",
        forecasts: [{
          city: "成都市",
          casts: [
            { date: "2026-10-16", dayweather: "小雨", nightweather: "多云", daytemp: "24", nighttemp: "18" },
            { date: "2026-10-17", dayweather: "晴", nightweather: "晴", daytemp: "26", nighttemp: "19" },
          ],
        }],
      }),
    })));
    const { fetchWeather } = await import("@/lib/weather");
    const r = await fetchWeather("成都");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") throw new Error("应为 ok");
    expect(r.days).toHaveLength(2);
    expect(r.days[0]).toMatchObject({ date: "2026-10-16", dayWeather: "小雨", dayTemp: "24" });
  });

  it("上游异常 → unavailable（由调用方跳过，不抛错）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: "0", info: "INVALID_USER_KEY" }) })));
    const { fetchWeather } = await import("@/lib/weather");
    const r = await fetchWeather("成都");
    expect(r.state).toBe("unavailable");
  });
});

describe("buildWeatherAdvice", () => {
  const rainy = {
    state: "ok" as const,
    days: [
      { date: "2026-10-16", dayWeather: "小雨", nightWeather: "多云", dayTemp: "24", nightTemp: "18" },
      { date: "2026-10-17", dayWeather: "晴", nightWeather: "晴", dayTemp: "26", nightTemp: "19" },
    ],
  };

  it("坏天气 + 室外景点 → 生成提示，且不改写行程内容", async () => {
    const plan = makePlan();
    const r = await buildWeatherAdvice(plan, rainy);

    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("第 1 天");
    expect(r.warnings[0]).toContain("小雨");
    expect(r.warnings[0]).toContain("武侯祠");
    // 核心原则：只提示不改写
    expect(plan.days[0].spots).toHaveLength(2);
    expect(plan.days[0].spots[0].name).toBe("武侯祠");
    expect(plan.warnings).toHaveLength(0); // 不擅自写进原 plan，由调用方决定
  });

  it("晴天不提示（不制造噪音）", async () => {
    const plan = makePlan({
      startDate: "2026-10-17", // 对准晴天那天
    });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.warnings).toHaveLength(0);
  });

  it("坏天气但当天无室外景点 → 不提示", async () => {
    const plan = makePlan({
      days: [{
        day: 1,
        theme: "逛吃",
        spots: [
          { period: "lunch", time: "12:00-13:00", type: "food", name: "餐厅", area: "武侯区", durationMin: 60, costCny: 50, reason: "test" },
        ],
        transitMin: 0,
        dailyCostCny: 50,
      }],
    });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.warnings).toHaveLength(0);
  });

  it("超出预报窗口的天 → 不猜天气（coveredDays 反映真实覆盖）", async () => {
    // 预报只到 10-17，行程第 3 天是 10-18——查不到就不说
    const plan = makePlan({
      days: [
        ...makePlan().days,
        { day: 2, theme: "第二天", spots: [{ period: "morning", time: "09:00-11:00", type: "sight", name: "杜甫草堂", area: "青羊区", durationMin: 120, costCny: 50, reason: "t" }], transitMin: 0, dailyCostCny: 50 },
        { day: 3, theme: "第三天", spots: [{ period: "morning", time: "09:00-11:00", type: "sight", name: "金沙遗址", area: "青羊区", durationMin: 120, costCny: 50, reason: "t" }], transitMin: 0, dailyCostCny: 50 },
      ],
    });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.coveredDays).toBe(2); // 只覆盖前两在，第三天没有预报
    expect(r.warnings).toHaveLength(1); // 只有第一天有雨
    expect(r.warnings[0]).toContain("第 1 天");
  });

  it("已有雨天备选的景点 → 提示可直接参考（信息更有用）", async () => {
    const plan = makePlan({
      days: [{
        day: 1,
        theme: "市区",
        spots: [
          { period: "morning", time: "09:00-11:00", type: "sight", name: "武侯祠", area: "武侯区", durationMin: 120, costCny: 50, reason: "t", rainBackup: "锦里" },
        ],
        transitMin: 0,
        dailyCostCny: 50,
      }],
    });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.warnings[0]).toContain("雨天备选");
  });

  it("天气 unavailable → 直接返回空（不报错、不猜）", async () => {
    const r = await buildWeatherAdvice(makePlan(), { state: "unavailable", reason: "no key" });
    expect(r.warnings).toHaveLength(0);
    expect(r.coveredDays).toBe(0);
  });

  it("没有 startDate 时安全返回（老数据/分享页兜底）", async () => {
    const plan = makePlan({ startDate: undefined });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.warnings).toHaveLength(0);
  });

  it("超过 3 个室外景点时列表截断，不刷屏", async () => {
    const plan = makePlan({
      days: [{
        day: 1,
        theme: "暴走",
        spots: ["A", "B", "C", "D", "E"].map((n) => ({
          period: "morning" as const, time: "09:00-10:00", type: "sight" as const,
          name: `景点${n}`, area: "武侯区", durationMin: 60, costCny: 0, reason: "t",
        })),
        transitMin: 0,
        dailyCostCny: 0,
      }],
    });
    const r = await buildWeatherAdvice(plan, rainy);
    expect(r.warnings[0]).toContain("5 个室外景点");
    expect(r.warnings[0]).toContain("等"); // 截断标记
    expect(r.warnings[0].split("、").length).toBeLessThanOrEqual(4); // 只列 3 个 + 尾巴
  });
});
