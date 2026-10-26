import { describe, expect, it } from "vitest";
import { clientIpFromHeaders, DIRECT_IP, trustedProxyHops } from "@/lib/client-ip";

// 客户端 IP 提取：审计 P0-3 的修复点。此前 8 处限流都取 XFF 首值，换一个头
// 就是新用户（LLM 账单无上限）。这里钉住「从右往左数受信代理」的取信规则。

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

const env = (over: Record<string, string | undefined> = {}) => ({ ...over });

describe("trustedProxyHops", () => {
  it("默认 1（假设前面有一层受信反代）", () => {
    expect(trustedProxyHops(env())).toBe(1);
  });

  it("显式 0 表示不信任何转发头", () => {
    expect(trustedProxyHops(env({ TRUSTED_PROXY_HOPS: "0" }))).toBe(0);
  });

  it("非法值回落默认值（不因配置错就信任全部）", () => {
    for (const bad of ["abc", "-1", "1.5", "99", ""]) {
      expect(trustedProxyHops(env({ TRUSTED_PROXY_HOPS: bad }))).toBe(1);
    }
  });
});

describe("clientIpFromHeaders", () => {
  it("单层反代：取 XFF 最右值（客户端伪造的左侧值被忽略）", () => {
    const h = headers({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    expect(clientIpFromHeaders(h, env())).toBe("203.0.113.7");
  });

  it("多层反代：从右往左数第 N 个（TRUSTED_PROXY_HOPS=2）", () => {
    const h = headers({ "x-forwarded-for": "8.8.8.8, 203.0.113.7, 10.0.0.1" });
    expect(clientIpFromHeaders(h, env({ TRUSTED_PROXY_HOPS: "2" }))).toBe("203.0.113.7");
  });

  it("hops=0：不信任转发头，所有请求共享 direct 桶", () => {
    const h = headers({ "x-forwarded-for": "1.2.3.4" });
    expect(clientIpFromHeaders(h, env({ TRUSTED_PROXY_HOPS: "0" }))).toBe(DIRECT_IP);
  });

  it("链不够长时退回 x-real-ip（仍只接受合法 IP）", () => {
    const h = headers({ "x-forwarded-for": "not-an-ip", "x-real-ip": "198.51.100.9" });
    expect(clientIpFromHeaders(h, env({ TRUSTED_PROXY_HOPS: "2" }))).toBe("198.51.100.9");
    const bad = headers({ "x-real-ip": "javascript:alert(1)" });
    expect(clientIpFromHeaders(bad, env({ TRUSTED_PROXY_HOPS: "2" }))).toBe(DIRECT_IP);
  });

  it("没有转发头：direct（不是旧的 local 之类）", () => {
    expect(clientIpFromHeaders(headers(), env())).toBe(DIRECT_IP);
  });

  it("容忍 IPv4:port 与 [IPv6]:port 写法", () => {
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "203.0.113.7:51234" }), env())).toBe(
      "203.0.113.7",
    );
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "[2001:db8::1]:443" }), env())).toBe(
      "2001:db8::1",
    );
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": "2001:db8::2" }), env())).toBe(
      "2001:db8::2",
    );
  });

  it("超长/垃圾值不会变成配额 key（全部丢弃后回落 direct）", () => {
    const junk = "x".repeat(5000);
    expect(clientIpFromHeaders(headers({ "x-forwarded-for": junk }), env())).toBe(DIRECT_IP);
  });
});
