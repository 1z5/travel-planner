import { afterEach, describe, expect, it, vi } from "vitest";

// 高德静态地图代理（server-only）单测。
//
// 重点钉住错误语义：**上游任何失败都不能被当成图片返回**。
// 高德的错误响应是 HTTP 200 + JSON（{status:"0",info,infocode}），
// 如果代理不校验 Content-Type/PNG 魔数，前端 <img> 会显示破图或把 JSON
// 当图片存进缓存——用户完全不知道发生了什么。

/** 1×1 合法 PNG（与 scripts/amap-stub.mjs 同一份字节，便于断言） */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const VIEW = { center: { lng: 104.0665, lat: 30.5728 }, zoom: 12 };

/** 模拟高德成功响应（image/png） */
function imageResponse(bytes: Buffer = PNG, contentType = "image/png"): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? contentType : null),
    },
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

/** 模拟高德 HTTP 200 + JSON 错误（真实形态：限流/key 失效都这样返回） */
function jsonError(info = "CUQPS_HAS_EXCEEDED_THE_LIMIT", infocode = "10021"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json;charset=UTF-8" },
    json: async () => ({ status: "0", info, infocode }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/** 模拟 HTTP 层错误（无可用 JSON body） */
function httpError(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => "text/plain" },
    json: async () => {
      throw new Error("not json");
    },
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

/**
 * 每个用例重新加载模块：staticMapEnabled 在 import 时由 key 决定，
 * 缓存也是模块级状态——不隔离会互相串味。
 */
async function loadStaticMap(opts: { key?: string | null; disabled?: boolean } = {}) {
  if (opts.key === null) delete process.env.AMAP_WEB_SERVICE_KEY;
  else process.env.AMAP_WEB_SERVICE_KEY = opts.key ?? "test-key";
  if (opts.disabled) process.env.AMAP_MAP_DISABLED = "1";
  else delete process.env.AMAP_MAP_DISABLED;
  delete process.env.AMAP_BASE_URL; // 默认走 https://restapi.amap.com
  vi.resetModules();
  return await import("@/lib/staticmap");
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AMAP_MAP_DISABLED;
  process.env.AMAP_WEB_SERVICE_KEY = "test-key";
});

describe("staticMapEnabled", () => {
  it("有高德 key 且未禁用 → true", async () => {
    const m = await loadStaticMap();
    expect(m.staticMapEnabled()).toBe(true);
  });

  it("无 key（MOCK 模式）→ false（不假装有地图）", async () => {
    const m = await loadStaticMap({ key: null });
    expect(m.staticMapEnabled()).toBe(false);
  });

  it("AMAP_MAP_DISABLED=1 → false（离线/预发环境可显式关掉，避免白打配额）", async () => {
    const m = await loadStaticMap({ disabled: true });
    expect(m.staticMapEnabled()).toBe(false);
  });
});

describe("buildStaticMapQuery（纯函数）", () => {
  const query = {
    location: "104.0665,30.5728",
    // 高德 zoom 编号比标准 Web Mercator 大 1：view.zoom=12 → 发送 11
    zoom: "11",
    size: "720*400",
    scale: "2",
  };

  it("参数与高德静态地图文档一致（location/zoom/size/scale）", async () => {
    const m = await loadStaticMap();
    expect(m.buildStaticMapQuery(VIEW, 720, 400, 2)).toEqual(query);
    expect(m.buildStaticMapQuery(VIEW, 720, 400, 1).scale).toBe("1");
  });

  it("zoom 编号偏移：发送给高德的 zoom = 标准 Web Mercator zoom - 1", async () => {
    // 实测坑（真 key + 图像配准）：高德静态地图 zoom 编号比标准口径大一级。
    // 若这里回归成直接透传，底图覆盖范围只有预期一半、自绘标记会全部漂走。
    const m = await loadStaticMap();
    expect(m.AMAP_ZOOM_OFFSET).toBe(1);
    expect(m.buildStaticMapQuery({ center: VIEW.center, zoom: 10 }, 720, 400, 2).zoom).toBe("9");
    expect(m.buildStaticMapQuery({ center: VIEW.center, zoom: 16 }, 720, 400, 2).zoom).toBe("15");
  });

  it("中心点保留 6 位小数（缓存 key 稳定，且远小于一个像素）", async () => {
    const m = await loadStaticMap();
    const q = m.buildStaticMapQuery(
      { center: { lng: 104.06651234567, lat: 30.5728999999 }, zoom: 13 },
      720,
      400,
      2,
    );
    expect(q.location).toBe("104.066512,30.5729");
    expect(q.zoom).toBe("12"); // 13 - AMAP_ZOOM_OFFSET(1)
  });

  it("不含 key（key 只在 staticmap.ts 内部拼到 URL 上，绝不进纯函数返回值）", async () => {
    const m = await loadStaticMap();
    const q = m.buildStaticMapQuery(VIEW, 720, 400, 2);
    expect(Object.keys(q).sort()).toEqual(["location", "scale", "size", "zoom"]);
    expect(JSON.stringify(q)).not.toContain("key");
  });
});

describe("fetchStaticMap 成功路径", () => {
  it("返回合法 PNG bytes + image/png，且请求参数正确（含 URL 编码）", async () => {
    // 显式声明入参，才能从 mock.calls 里取回 fetch 收到的 URL
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("应成功");
    expect(r.contentType).toBe("image/png");
    expect(r.bytes.equals(PNG)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const rawUrl = String(fetchMock.mock.calls[0]![0]);
    const url = new URL(rawUrl);
    expect(url.origin).toBe("https://restapi.amap.com");
    expect(url.pathname).toBe("/v3/staticmap");
    expect(url.searchParams.get("key")).toBe("test-key");
    expect(url.searchParams.get("location")).toBe("104.0665,30.5728");
    expect(url.searchParams.get("zoom")).toBe("11"); // view.zoom 12 - 高德编号偏移 1
    expect(url.searchParams.get("size")).toBe("720*400");
    expect(url.searchParams.get("scale")).toBe("2");
    // 原始 URL 里逗号必须被编码（不经编码的逗号会被某些代理/日志截断）
    expect(rawUrl).toContain("location=104.0665%2C30.5728");
  });

  it("相同视野命中缓存：第二次不再打高德（QPS 保护）", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    await m.fetchStaticMap(VIEW, 720, 400, 2);
    const second = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(m.staticMapCacheSize()).toBe(1);
  });

  it("不同视野各自请求（缓存 key 含完整参数）", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    await m.fetchStaticMap(VIEW, 720, 400, 2);
    await m.fetchStaticMap({ center: { lng: 104.02, lat: 30.55 }, zoom: 13 }, 720, 400, 2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(m.staticMapCacheSize()).toBe(2);
  });
});

describe("fetchStaticMap 错误路径：绝不把上游错误当图片", () => {
  it("QPS 限流（瞬时）：退避后重试 1 次成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonError("CUQPS_HAS_EXCEEDED_THE_LIMIT", "10021"))
      .mockResolvedValueOnce(imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("key 无效（非瞬时）：不重试，返回 502 且 reason 带 infocode", async () => {
    const fetchMock = vi.fn(async () => jsonError("INVALID_USER_KEY", "10001"));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("应失败");
    expect(r.status).toBe(502);
    expect(r.reason).toContain("10001");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 失败不缓存：下次仍会重新尝试（不能把一次抖动永久固化成「地图不可用」）
    expect(m.staticMapCacheSize()).toBe(0);
  }, 10_000);

  it("网络异常：重试 1 次后返回 502（不退化成空图片）", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("应失败");
    expect(r.status).toBe(502);
    expect(r.reason).toContain("network down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("HTTP 500（瞬时）：重试后仍失败 → 502", async () => {
    const fetchMock = vi.fn(async () => httpError(500));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("HTTP 403（非瞬时）：只请求一次，返回 502", async () => {
    const fetchMock = vi.fn(async () => httpError(403));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("Content-Type 是图片但字节不是 PNG：拒绝（防止上游返回空 body/HTML）", async () => {
    const fetchMock = vi.fn(async () => imageResponse(Buffer.from("<html>oops</html>")));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("应失败");
    expect(r.reason).toContain("PNG");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("非图片 Content-Type 且 body 不是 JSON：返回 502，不当图片", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "text/html" },
      json: async () => {
        throw new Error("not json");
      },
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap();

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("应失败");
    expect(r.status).toBe(502);
  });

  it("未配置 key：直接 503，一个上游请求都不发", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const m = await loadStaticMap({ key: null });

    const r = await m.fetchStaticMap(VIEW, 720, 400, 2);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("应失败");
    expect(r.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
