import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// AMAP_MOCK 在模块加载时由 env 计算，必须在 import 之前把 key 设好
process.env.AMAP_WEB_SERVICE_KEY = "test-key";

// lib/amap.ts 顶部 import "server-only"：Vitest 侧由 vitest.config.mts 的
// resolve.alias 指到 tests/stubs/server-only.js（空模块）
const { AMAP_MOCK, lookupPoi, routeSegment, transitMinutes } = await import("@/lib/amap");
const { validatePlan } = await import("@/lib/validate");
import type { Plan, PlanInput } from "@/lib/types";

// ---------- 桩 fetch：按 URL 路径 + keywords 分支，模拟高德的各类响应 ----------

function res(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface RouterOpts {
  /** 这些 POI 名返回 QPS 超限错误码（瞬时失败） */
  qpsFor?: string[];
  /** 这些 POI 名让 fetch 直接抛错（网络异常） */
  throwFor?: string[];
  /** 这些 POI 名返回 key 无效（非瞬时失败，不应重试） */
  badKeyFor?: string[];
  /** 距离接口返回的距离（米）；"bad" = 上游错误，"" = 无 paths */
  distance?: string;
}

function useRouter(opts: RouterOpts = {}) {
  const mock = vi.fn(async (input: unknown) => {
    const url = new URL(String(input));
    const kw = url.searchParams.get("keywords") ?? "";
    if (url.pathname.includes("/v3/place/text")) {
      if (opts.throwFor?.includes(kw)) throw new Error("network down");
      if (opts.badKeyFor?.includes(kw)) {
        return res({ status: "0", info: "INVALID_USER_KEY", infocode: "10001" });
      }
      if (opts.qpsFor?.includes(kw)) {
        return res({ status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT", infocode: "10003" });
      }
      if (kw.includes("查无此")) return res({ status: "1", pois: [] });
      return res({
        status: "1",
        pois: [{ name: kw, address: "测试地址", location: "120.620000,31.320000", adname: "姑苏区" }],
      });
    }
    if (/\/v5\/direction\/(walking|bicycling|driving)/.test(url.pathname)) {
      if (opts.distance === "bad") {
        return res({ status: "0", info: "SERVER_BUSY", infocode: "10021" });
      }
      if (opts.distance === "") return res({ status: "1", route: { paths: [] } });
      const steps = [
        { instruction: "向东北步行<b>341</b>米左转" },
        { instruction: "沿道路直行200米" },
        { instruction: "   " },
        { instruction: "到达目的地" },
      ];
      // 按交通方式还原真实形状（与 scripts/amap-stub.mjs 同口径）：
      // walking/bicycling 的时长在 path.cost.duration、顶层无 duration；
      // driving 全链路无时长字段。此前统一给 driving 造假 duration，导致
      // routeSegment 的错误分支在桩下永远命中、盖住真机 bug。
      if (url.pathname.endsWith("/driving")) {
        return res({
          status: "1",
          route: { paths: [{ distance: opts.distance ?? "5000", restriction: "0", steps }] },
        });
      }
      return res({
        status: "1",
        route: { paths: [{ distance: opts.distance ?? "5000", cost: { duration: "700" }, steps }] },
      });
    }
    return res({ status: "0", info: "unknown path" }, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  useRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 注意：POI 缓存是模块级状态（30min / error 10s），**每个测试必须用独有的
// 地名**，否则后一个测试会读到前一个测试缓存的 hit/miss/error。

// ---------- lookupPoi：三态语义 ----------

describe("lookupPoi 三态语义", () => {
  it("配置了 key 时不是 MOCK 模式", () => {
    expect(AMAP_MOCK).toBe(false);
  });

  it("status=1 且有 pois → hit，按高德形状映射字段", async () => {
    const r = await lookupPoi("苏州", "拙政园");
    expect(r.state).toBe("hit");
    if (r.state !== "hit") throw new Error("应为 hit");
    expect(r.poi).toEqual({
      name: "拙政园",
      address: "测试地址",
      location: "120.620000,31.320000",
      adname: "姑苏区",
      verified: true,
    });
  });

  it("status=1 但无 pois → miss（这是预警唯一合法的触发条件）", async () => {
    const r = await lookupPoi("苏州", "查无此店甲");
    expect(r.state).toBe("miss");
  });

  it("miss 是有效答案，不触发重试（只请求一次）", async () => {
    const mock = useRouter();
    await lookupPoi("苏州", "查无此店乙");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("QPS 超限（瞬时）→ 退避重试 3 次后 error，**绝不**降级成 miss", async () => {
    // 这是本轮修复的核心回归：以前网络/上游异常被当成「未检索到」，
    // 于是一堆真实存在的景点会被标成不存在——预警系统自己变成谎言
    const mock = useRouter({ qpsFor: ["虎丘"] });
    const r = await lookupPoi("苏州", "虎丘");
    expect(r.state).toBe("error");
    if (r.state !== "error") throw new Error("应为 error");
    expect(r.reason).toContain("10003");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("网络异常（fetch 抛错）→ 重试后 error", async () => {
    const mock = useRouter({ throwFor: ["寒山寺"] });
    const r = await lookupPoi("苏州", "寒山寺");
    expect(r.state).toBe("error");
    if (r.state !== "error") throw new Error("应为 error");
    expect(r.reason).toContain("network down");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("key 无效（非瞬时）→ 不重试，一次即 error", async () => {
    const mock = useRouter({ badKeyFor: ["留园"] });
    const r = await lookupPoi("苏州", "留园");
    expect(r.state).toBe("error");
    if (r.state !== "error") throw new Error("应为 error");
    expect(r.reason).toContain("10001");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("HTTP 500（瞬时）→ 重试后 error", async () => {
    const mock = vi.fn(async () => res({ status: "0", info: "boom" }, 500));
    vi.stubGlobal("fetch", mock);
    const r = await lookupPoi("苏州", "网师园");
    expect(r.state).toBe("error");
    expect(mock).toHaveBeenCalledTimes(3);
  });
});

// ---------- 缓存与在飞去重 ----------

describe("缓存与在飞去重", () => {
  it("命中的 POI 走缓存：第二次不发起请求", async () => {
    const mock = useRouter();
    await lookupPoi("苏州", "平江路");
    await lookupPoi("苏州", "平江路");
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("error 结果按短 TTL 缓存：服务抖动期间不重复敲打", async () => {
    const mock = useRouter({ qpsFor: ["狮子林"] });
    const r1 = await lookupPoi("苏州", "狮子林");
    const r2 = await lookupPoi("苏州", "狮子林");
    expect(r1.state).toBe("error");
    expect(r2.state).toBe("error");
    // 第一次 3 次尝试，第二次直接命中 error 缓存，不再发请求
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("并发同名请求在飞去重：只发起一次上游调用", async () => {
    const mock = useRouter();
    const [a, b] = await Promise.all([
      lookupPoi("苏州", "苏州博物馆"),
      lookupPoi("苏州", "苏州博物馆"),
    ]);
    expect(a).toEqual(b);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

// ---------- transitMinutes：两态语义 ----------

describe("transitMinutes 两态语义", () => {
  it("两端命中 + 距离 5000 米 → 22 分钟（5000/1000/22*60+8≈21.6）", async () => {
    const r = await transitMinutes("苏州", "观前街", "山塘街");
    expect(r).toEqual({ state: "ok", minutes: 22 });
  });

  it("一端 miss（地名解析失败）→ 沿用 30 分钟保守值", async () => {
    const r = await transitMinutes("苏州", "观前街", "查无此店丙");
    expect(r).toEqual({ state: "ok", minutes: 30 });
  });

  it("一端 error → unknown，且不再调用距离接口（不拿假数据参与绕路预警）", async () => {
    const mock = useRouter({ qpsFor: ["西园寺"] });
    const r = await transitMinutes("苏州", "观前街", "西园寺");
    expect(r.state).toBe("unknown");
    if (r.state !== "unknown") throw new Error("应为 unknown");
    expect(r.reason).toContain("西园寺");
    // 只有 POI 解析的重试，没有任何 driving 调用
    const drivingCalls = mock.mock.calls.filter((c) => String(c[0]).includes("/v5/direction/driving"));
    expect(drivingCalls).toHaveLength(0);
  });

  it("距离接口上游错误 → unknown", async () => {
    useRouter({ distance: "bad" });
    const r = await transitMinutes("苏州", "石路", "苏州大学");
    expect(r.state).toBe("unknown");
    if (r.state !== "unknown") throw new Error("应为 unknown");
    expect(r.reason).toContain("10021");
  });

  it("距离接口返回空 paths → unknown", async () => {
    useRouter({ distance: "" });
    const r = await transitMinutes("苏州", "相门", "东环");
    expect(r.state).toBe("unknown");
  });

  it("距离为 0 或非法 → unknown", async () => {
    useRouter({ distance: "0" });
    const r = await transitMinutes("苏州", "葑门", "娄门");
    expect(r.state).toBe("unknown");
    if (r.state !== "unknown") throw new Error("应为 unknown");
    expect(r.reason).toContain("未返回有效数据");
  });
});

// 退避策略的回归（真机日志踩坑后补）：
// 高德 QPS 是秒级窗口，限流类失败若用短退避（150ms/400ms），三次尝试
// 全落在同一秒内、必然连续超限——真机实测 driving 接口 3 次重试全失败，
// 导致当天通勤估算失败、节奏体检被跳过。限流类必须跨过秒级窗口。
describe("QPS 限流的退避策略", () => {
  it("限流类失败：重试间隔跨过秒级窗口（≥1s），不是 150ms 短退避", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const timestamps: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        timestamps.push(Date.now());
        return res({ status: "0", info: "CUQPS_HAS_EXCEEDED_THE_LIMIT", infocode: "10021" });
      }),
    );
    const { lookupPoi } = await import("@/lib/amap");
    await lookupPoi("成都", "限流退避测试");

    expect(timestamps).toHaveLength(3); // 三次尝试都发生了
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    // 关键断言：两次间隔都必须跨过秒级窗口（远大于原来的 150ms/400ms）
    expect(gap1).toBeGreaterThanOrEqual(900);
    expect(gap2).toBeGreaterThanOrEqual(1800);
  });

  it("网络类失败：仍用短退避（不等 1 秒，避免无谓拖慢）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const timestamps: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        timestamps.push(Date.now());
        throw new Error("network down");
      }),
    );
    const { lookupPoi } = await import("@/lib/amap");
    await lookupPoi("成都", "网络退避测试");

    expect(timestamps).toHaveLength(3);
    const gap1 = timestamps[1] - timestamps[0];
    const gap2 = timestamps[2] - timestamps[1];
    // 网络异常是瞬时恢复，退避应远小于限流类
    expect(gap1).toBeLessThan(900);
    expect(gap2).toBeLessThan(1800);
  });
});

// ---------- routeSegment：分段路线（「行中」串路线用） ----------

describe("routeSegment 三态与解析", () => {
  const O = "120.62,31.32";
  const D = "120.65,31.30";

  it("ok：解析距离/时长/分步指令", async () => {
    useRouter();
    const r = await routeSegment(O, D, "walking");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.leg.distanceM).toBe(5000);
    // walking/bicycling 的时长在 path.cost.duration（实测真实形状，顶层无 duration）
    expect(r.leg.durationSec).toBe(700);
    // 分步：剥掉 HTML 标签、丢掉空串、最多 3 条
    expect(r.leg.steps).toEqual(["向东北步行341米左转", "沿道路直行200米", "到达目的地"]);
  });

  it("按交通方式走不同高德端点", async () => {
    // useRouter 内部会 stubGlobal 换一个新的 fetch mock 并返回它——
    // 必须接住这个返回值，不能用 vi.mocked(fetch)（那指向旧的全局 mock）
    const mock = useRouter();
    await routeSegment(O, D, "walking");
    await routeSegment(O, D, "bicycling");
    await routeSegment(O, D, "driving");
    const paths = mock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).toContain("/v5/direction/walking");
    expect(paths).toContain("/v5/direction/bicycling");
    expect(paths).toContain("/v5/direction/driving");
  });

  it("driving 无时长字段，按均速从距离折算（真机实测的形状）", async () => {
    // 真机直连实测：driving 全链路不返回时长（paths[0] 只有 distance/
    // restriction/steps）。此前按「driving 在 cost.duration」写、配造假 duration
    // 的桩，测试全绿却真机 legs 全空。现在 driving 走「从距离折算」：
    // 5000/1000/22*60+8 ≈ 74 分钟。
    useRouter({ distance: "5000" });
    const r = await routeSegment(O, D, "driving");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.leg.durationSec).toBe(Math.round((5000 / 1000 / 22) * 60 + 8));
  });

  it("上游错误 → unknown（不返回半截路线）", async () => {
    useRouter({ distance: "bad" });
    const r = await routeSegment(O, D, "walking");
    expect(r.state).toBe("unknown");
  });

  it("空 paths → unknown", async () => {
    useRouter({ distance: "" });
    const r = await routeSegment(O, D, "walking");
    expect(r.state).toBe("unknown");
    if (r.state !== "unknown") return;
    expect(r.reason).toContain("未返回有效距离");
  });

  it("没有 steps 也能 ok（steps 为空数组，不阻断）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => res({
      status: "1",
      route: { paths: [{ distance: "800", duration: "120" }] },
    })));
    const r = await routeSegment(O, D, "bicycling");
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.leg.steps).toEqual([]);
    expect(r.leg.distanceM).toBe(800);
  });
});

// ---------- validatePlan 的 legs 收窄（refine 只改一天，不该白算全天） ----------
// 改行程只动一天：其余天的 spot 是原对象引用、坐标没变，legs 重算结果不会变，
// 却要各打一次无缓存的 direction 接口（5 天行程 20+ 次，全阻塞在同步的
// 「换一个」响应里）。这里钉住 recomputeDays 参数：只有名单里的天重算 legs。

describe("validatePlan 的 legs 收窄", () => {
  const input = { city: "杭州", days: 3, budget: 3000, transportMode: "driving" } as unknown as PlanInput;
  const spot = (name: string, location: string) => ({
    period: "morning", time: "09:00-10:00", type: "sight", name, area: "西湖",
    durationMin: 60, costCny: 0, reason: "测试", location,
  });
  const day = (n: number, legs?: unknown) => ({
    day: n, theme: `第${n}天`, transitMin: 0, dailyCostCny: 0,
    legs: legs as Plan["days"][number]["legs"],
    spots: [spot(`${n}-甲`, "120.10,30.10"), spot(`${n}-乙`, "120.20,30.20")],
  });
  const plan = () => ({
    city: "杭州", summary: "测试", totalCostCny: 0, tips: [], warnings: [],
    verified: true, days: [day(1), day(2), day(3)],
  }) as unknown as Plan;

  it("不传 recomputeDays：所有天都算 legs（首生成路径不变）", async () => {
    useRouter();
    const p = plan();
    await validatePlan(p, input);
    expect((p.days[0].legs ?? []).length).toBe(1);
    expect((p.days[1].legs ?? []).length).toBe(1);
    expect((p.days[2].legs ?? []).length).toBe(1);
  });

  it("recomputeDays=[2]：只有第 2 天重算，其余天 legs 原样保留（同一引用）", async () => {
    useRouter();
    const p = plan();
    const kept = [{ from: "旧", to: "legs", mode: "driving" as const, distanceM: 1, durationSec: 1, steps: [] }];
    p.days[0].legs = kept;
    p.days[2].legs = kept;
    await validatePlan(p, input, [2]);
    // 未指定的天：legs 引用没被换掉（没有重算）
    expect(p.days[0].legs).toBe(kept);
    expect(p.days[2].legs).toBe(kept);
    // 指定的天：legs 被重算成新数组（不再是 kept）
    expect(p.days[1].legs).not.toBe(kept);
    expect((p.days[1].legs ?? []).length).toBe(1);
  });

  it("recomputeDays 指定的天若算不出 legs，不设字段（其余天不受影响）", async () => {
    // distance 为空 → routeSegment 全 unknown → 第 2 天无 legs，但不波及 1、3 天
    useRouter({ distance: "" });
    const p = plan();
    const kept = [{ from: "旧", to: "legs", mode: "driving" as const, distanceM: 1, durationSec: 1, steps: [] }];
    p.days[0].legs = kept;
    p.days[2].legs = kept;
    await validatePlan(p, input, [2]);
    expect(p.days[1].legs).toBeUndefined();
    expect(p.days[0].legs).toBe(kept);
    expect(p.days[2].legs).toBe(kept);
  });
});

// 通勤估算的收窄（refine 未改的天不该白打 driving 接口）。transitMinutes 只有
// poiCache 缓存地名→坐标，driving 调用本身无缓存——未改的天 spot 没变、transitMin
// 已在对象上，重算纯属浪费，且阻塞在同步的「换一个」响应里。
describe("validatePlan 的通勤收窄", () => {
  const input = { city: "杭州", days: 3, budget: 3000, transportMode: "driving" } as unknown as PlanInput;
  const spot = (name: string, location: string) => ({
    period: "morning", time: "09:00-10:00", type: "sight", name, area: "西湖",
    durationMin: 60, costCny: 0, reason: "测试", location,
  });
  const day = (n: number, transitMin = 0, transitKnown?: boolean) => ({
    day: n, theme: `第${n}天`, transitMin, transitKnown, dailyCostCny: 0,
    spots: [spot(`${n}-甲`, "120.10,30.10"), spot(`${n}-乙`, "120.20,30.20")],
  });
  const plan = () => ({
    city: "杭州", summary: "测试", totalCostCny: 0, tips: [], warnings: [],
    verified: true, days: [day(1, 148, true), day(2), day(3, 90, true)],
  }) as unknown as Plan;

  it("不传 recomputeDays：所有天都重算通勤（首生成路径不变）", async () => {
    useRouter();
    const p = plan();
    await validatePlan(p, input);
    // driving 无时长 → 每段折算 5000/1000/22*60+8 = 22 分钟；每天 1 段
    expect(p.days[0].transitMin).toBe(22);
    expect(p.days[1].transitMin).toBe(22);
    expect(p.days[2].transitMin).toBe(22);
  });

  it("recomputeDays=[2]：未改天沿用旧 transitMin，只有第 2 天重算", async () => {
    useRouter();
    const p = plan();
    await validatePlan(p, input, [2]);
    expect(p.days[0].transitMin).toBe(148); // 原值保留，没重算
    expect(p.days[3 - 1].transitMin).toBe(90); // 第 3 天原值 90 保留
    expect(p.days[1].transitMin).toBe(22);   // 第 2 天重算（driving 折算）
  });

  it("未改天的 transitKnown=false 被沿用（不把旧失败结论改成成功）", async () => {
    useRouter();
    const p = plan();
    p.days[0].transitKnown = false; // 原来这天通勤估算失败
    p.days[0].transitMin = 0;
    await validatePlan(p, input, [2]);
    // 未改的第 1 天：transitKnown 仍是 false，不因跳过重算而被“洗白”
    expect(p.days[0].transitKnown).toBe(false);
    expect(p.days[0].transitMin).toBe(0);
  });
});
