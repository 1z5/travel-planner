import { describe, expect, it } from "vitest";
import { FEATURED_DESTINATIONS, featuredHref } from "@/lib/featured-destinations";
import { PREF_OPTIONS } from "@/app/home-client";

// 首屏「灵感三卡」的数据契约。
//
// 为什么值得单测：这些卡会被拼成 /new 深链，交给表单去预填。数据一旦超出表单
// 认识的范围（天数不在 1-7、偏好不在白名单、预算不是合法整数），用户点开得到
// 的是一张「静默缺条件」的表单：偏好被过滤掉、天数不生效，而界面上没有任何
// 报错——比不预填更糟。
//
// 同时守住诚实口径：这些卡是「示例条件」，不是已核验行程，文案里不许出现
// 暗示已验真或编造热度/销量的说法。

/** 与 app/home-client.tsx 的 CITY_INPUT_RE 同口径：2-20 位中英文/间隔号 */
const CITY_RE = /^[\u4e00-\u9fa5A-Za-z·\-\s]{2,20}$/;

/** 文案红线：这卡不是已核验行程，也不能拿编造数据充门面 */
const FORBIDDEN_COPY = ["已验真", "已核验", "验真通过", "热门", "爆款", "10w+", "万人"];

describe("精选目的地数据契约", () => {
  it("恰好 3 条，城市合法、不重复（首屏只给三个起点，多了变成负担）", () => {
    expect(FEATURED_DESTINATIONS).toHaveLength(3);
    const cities = FEATURED_DESTINATIONS.map((d) => d.city);
    expect(new Set(cities).size).toBe(cities.length);
    for (const city of cities) expect(city).toMatch(CITY_RE);
  });

  it("天数是 1-7 的整数（与表单起止时间支持的区间一致）", () => {
    for (const d of FEATURED_DESTINATIONS) {
      expect(Number.isInteger(d.days)).toBe(true);
      expect(d.days).toBeGreaterThanOrEqual(1);
      expect(d.days).toBeLessThanOrEqual(7);
    }
  });

  it("偏好落在表单白名单内、不重复、最多 5 个（否则预填时被静默过滤）", () => {
    for (const d of FEATURED_DESTINATIONS) {
      expect(d.prefs.length).toBeGreaterThan(0);
      expect(d.prefs.length).toBeLessThanOrEqual(5);
      expect(new Set(d.prefs).size).toBe(d.prefs.length);
      for (const p of d.prefs) expect(PREF_OPTIONS).toContain(p);
    }
  });

  it("highlights 是 2-3 条非空且不重复的具体玩法", () => {
    for (const d of FEATURED_DESTINATIONS) {
      expect(d.highlights.length).toBeGreaterThanOrEqual(2);
      expect(d.highlights.length).toBeLessThanOrEqual(3);
      expect(new Set(d.highlights).size).toBe(d.highlights.length);
      for (const h of d.highlights) expect(h.trim().length).toBeGreaterThan(0);
    }
  });

  it("预算能被表单接受（整数、0-200000 的合法输入）", () => {
    for (const d of FEATURED_DESTINATIONS) {
      expect(Number.isInteger(d.budget)).toBe(true);
      expect(d.budget).toBeGreaterThanOrEqual(0);
      expect(d.budget).toBeLessThanOrEqual(200000);
    }
  });

  it("blurb 是有效文案，且所有文案不越诚实红线（不暗示已验真/不编造热度）", () => {
    for (const d of FEATURED_DESTINATIONS) {
      expect(d.blurb.trim().length).toBeGreaterThan(0);
      const copy = [d.blurb, ...d.highlights].join("");
      for (const word of FORBIDDEN_COPY) expect(copy).not.toContain(word);
    }
  });
});

describe("featuredHref", () => {
  it("拼成 /new 深链，参数经 URL 编码但仍能还原成原条件", () => {
    for (const d of FEATURED_DESTINATIONS) {
      const href = featuredHref(d);
      // 中文必须被编码：未编码的 URL 在部分浏览器/代理下会被截断
      expect(href).not.toMatch(/[\u4e00-\u9fa5]/);
      expect(href.startsWith("/new?")).toBe(true);

      const url = new URL(href, "https://example.test");
      expect(url.pathname).toBe("/new");
      expect(url.searchParams.get("city")).toBe(d.city);
      expect(url.searchParams.get("days")).toBe(String(d.days));
      expect(url.searchParams.get("prefs")).toBe(d.prefs.join(","));
    }
  });

  it("深链参数正好是表单预填认识的三项（不多带、不带 MOCK 标记等内部信息）", () => {
    for (const d of FEATURED_DESTINATIONS) {
      const url = new URL(featuredHref(d), "https://example.test");
      expect([...url.searchParams.keys()].sort()).toEqual(["city", "days", "prefs"]);
    }
  });
});
