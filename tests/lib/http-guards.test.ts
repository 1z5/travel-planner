import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { readBody, readJsonBody } from "@/lib/http-body";
import { crossSiteWriteError, isSameOriginRequest } from "@/lib/http-origin";

function req(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1:3000/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

describe("http-body · 请求体体积上限", () => {
  it("正常小 JSON：读取并解析成功", async () => {
    const r = await readJsonBody(req('{"shareId":"share_abcdefgh"}'));
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.json as { shareId: string }).shareId).toBe("share_abcdefgh");
  });

  it("Content-Length 超限 → 413（不读 body）", async () => {
    const r = await readBody(req("{}", { "Content-Length": String(32 * 1024) }), 16 * 1024);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(413);
      expect(r.error).toContain("超过");
    }
  });

  it("实际字节数超限（多字节中文也算字节）→ 413", async () => {
    const big = JSON.stringify({ x: "汉".repeat(1000) }); // 1000 字符 ≈ 3KB 字节
    const r = await readBody(req(big), 1024); // 上限 1KB：字符数没超、字节数超了
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(413);
  });

  it("非法 JSON → 400 invalid_json", async () => {
    const r = await readJsonBody(req("{not json"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toBe("invalid_json");
    }
  });
});

describe("http-origin · 跨站写保护", () => {
  const same = req("{}", { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" });
  const other = req("{}", { origin: "https://evil.example", host: "127.0.0.1:3000" });
  const noOrigin = req("{}", { host: "127.0.0.1:3000" });
  const crossSite = req("{}", {
    origin: "http://127.0.0.1:3000",
    host: "127.0.0.1:3000",
    "sec-fetch-site": "cross-site",
  });
  const badOrigin = req("{}", { origin: "not a url", host: "127.0.0.1:3000" });

  it("同源 → 放行；无 Origin（curl/agent）→ 放行", () => {
    expect(isSameOriginRequest(same)).toBe(true);
    expect(isSameOriginRequest(noOrigin)).toBe(true);
    expect(crossSiteWriteError(same)).toBeNull();
    expect(crossSiteWriteError(noOrigin)).toBeNull();
  });

  it("跨源 Origin / 畸形 Origin / Sec-Fetch-Site=cross-site → 拒绝", () => {
    expect(isSameOriginRequest(other)).toBe(false);
    expect(isSameOriginRequest(badOrigin)).toBe(false);
    expect(isSameOriginRequest(crossSite)).toBe(false);
    expect(crossSiteWriteError(other)).toContain("跨站请求被拒绝");
  });
});
