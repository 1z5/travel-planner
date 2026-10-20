import { describe, expect, it, vi, afterEach } from "vitest";

// 区域规划（scope=region）的核心行为验证。
//
// 关键差异：区域的 POI 分散在多个行政区，而高德不认识「川西环线」这个 city——
// 若沿用城市模式的 citylimit=true，会把搜索结果全部滤空，区域行程的 POI
// 验真就全废了。所以区域模式必须放开 citylimit（按关键词全局搜）。

const BASE = "https://restapi.amap.com";

/** 记录 fetch 收到的 URL，返回可断言的调用列表 */
function captureFetch(responder?: (url: URL) => unknown) {
  const calls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input));
      calls.push(url);
      const body = responder
        ? responder(url)
        : { status: "1", pois: [{ name: "x", address: "a", location: "116.4,39.9", adname: "b" }] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("lookupPoi 的 scope 行为", () => {
  it("城市模式：带 city + citylimit=true（收窄到目标城市，防同名 POI 误配）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const { lookupPoi } = await import("@/lib/amap");
    const calls = captureFetch();

    await lookupPoi("成都", "武侯祠", "city");

    const url = calls[0];
    expect(url.pathname).toBe("/v3/place/text");
    expect(url.searchParams.get("city")).toBe("成都");
    expect(url.searchParams.get("citylimit")).toBe("true");
  });

  it("区域模式：不带 city/citylimit（否则被不存在的区域名滤空）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const { lookupPoi } = await import("@/lib/amap");
    const calls = captureFetch();

    await lookupPoi("川西环线", "四姑娘山", "region");

    const url = calls[0];
    expect(url.pathname).toBe("/v3/place/text");
    expect(url.searchParams.get("keywords")).toBe("四姑娘山");
    // 这是本组测试的核心断言
    expect(url.searchParams.get("citylimit")).toBeNull();
    expect(url.searchParams.get("city")).toBeNull();
  });

  it("scope 默认 city（不传参时保持原有行为，向后兼容）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const { lookupPoi } = await import("@/lib/amap");
    const calls = captureFetch();

    await lookupPoi("成都", "武侯祠");

    expect(calls[0].searchParams.get("citylimit")).toBe("true");
  });

  it("两种 scope 的缓存键不互相污染（同名 POI 在不同范围下结果不同）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const { lookupPoi } = await import("@/lib/amap");
    let callCount = 0;
    const calls = captureFetch(() => {
      callCount += 1;
      return {
        status: "1",
        pois: [{ name: `p${callCount}`, address: "a", location: "116.4,39.9", adname: "b" }],
      };
    });

    const cityResult = await lookupPoi("成都", "同名寺", "city");
    const regionResult = await lookupPoi("川西环线", "同名寺", "region");

    // 两次都真实发了请求（没有被第一次的缓存命中挡住），且 URL 不同
    expect(calls).toHaveLength(2);
    expect(calls[0].searchParams.get("citylimit")).toBe("true");
    expect(calls[1].searchParams.get("citylimit")).toBeNull();
    expect(cityResult.state).toBe("hit");
    expect(regionResult.state).toBe("hit");
  });

  it("区域模式下通勤估算同样放开 citylimit（transitMinutes 内部走 lookupPoi）", async () => {
    process.env.AMAP_WEB_SERVICE_KEY = "test-key";
    vi.resetModules();
    const { transitMinutes } = await import("@/lib/amap");
    const calls = captureFetch((url) => {
      if (url.pathname.includes("/place/text")) {
        return {
          status: "1",
          pois: [{ name: "x", address: "a", location: "103.0,30.0", adname: "b" }],
        };
      }
      return { status: "1", route: { paths: [{ distance: "5000" }] } };
    });

    const r = await transitMinutes("川西环线", "四姑娘山", "丹巴", "region");

    expect(r.state).toBe("ok");
    const placeCalls = calls.filter((u) => u.pathname.includes("/place/text"));
    expect(placeCalls.length).toBe(2); // 起点 + 终点各解析一次
    for (const u of placeCalls) {
      expect(u.searchParams.get("citylimit")).toBeNull();
    }
    // 距离接口收到的是坐标（区域模式解析出的 location），不是地名
    const driving = calls.find((u) => u.pathname.includes("/direction/driving"))!;
    expect(driving.searchParams.get("origin")).toMatch(/^\d+\.\d+,\d+\.\d+$/);
  });
});
