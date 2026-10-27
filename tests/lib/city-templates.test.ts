import { describe, expect, it } from "vitest";
import {
  CITY_TEMPLATES,
  cityTemplateByCity,
  cityTemplateBySlug,
  templateHref,
} from "@/lib/city-templates";
import { PREF_OPTIONS } from "@/lib/pref-options";

// 城市模板：数据完整性与诚实口径的机器约束（页面文案靠人，字段靠测试）。

describe("city templates 数据", () => {
  it("至少 12 城，slug 唯一且只含小写字母/连字符", () => {
    expect(CITY_TEMPLATES.length).toBeGreaterThanOrEqual(12);
    const slugs = CITY_TEMPLATES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z][a-z-]*$/);
  });

  it("每城都有 3/4/5 天三档，且天数严格递增", () => {
    for (const c of CITY_TEMPLATES) {
      expect(c.variants.map((v) => v.days)).toEqual([3, 4, 5]);
    }
  });

  it("偏好全部落在白名单内（否则深链会被表单静默过滤）", () => {
    for (const c of CITY_TEMPLATES) {
      for (const v of c.variants) {
        expect(v.prefs.length).toBeGreaterThan(0);
        expect(v.prefs.length).toBeLessThanOrEqual(5);
        for (const p of v.prefs) expect(PREF_OPTIONS).toContain(p);
      }
    }
  });

  it("预算为正整数、城市/标签/文案非空（不出现空壳页面）", () => {
    for (const c of CITY_TEMPLATES) {
      expect(c.city.length).toBeGreaterThan(0);
      expect(c.region.length).toBeGreaterThan(0);
      expect(c.tagline.length).toBeGreaterThan(8);
      expect(c.season.length).toBeGreaterThan(2);
      for (const v of c.variants) {
        expect(Number.isInteger(v.budget)).toBe(true);
        expect(v.budget).toBeGreaterThan(0);
        expect(v.blurb.length).toBeGreaterThan(10);
      }
    }
  });

  it("查找：slug/城市名均可，找不到返回 undefined", () => {
    expect(cityTemplateBySlug("chengdu")?.city).toBe("成都");
    expect(cityTemplateByCity("成都")?.slug).toBe("chengdu");
    expect(cityTemplateBySlug("atlantis")).toBeUndefined();
    expect(cityTemplateByCity("亚特兰蒂斯")).toBeUndefined();
  });

  it("深链：city/days/prefs 正确编码，且能被 URLSearchParams 还原", () => {
    const href = templateHref("成都", 3, ["美食", "历史文化"]);
    const url = new URL(href, "https://example.com");
    expect(url.pathname).toBe("/new");
    expect(url.searchParams.get("city")).toBe("成都");
    expect(url.searchParams.get("days")).toBe("3");
    expect(url.searchParams.get("prefs")).toBe("美食,历史文化");
    // 无偏好不带 prefs 参数
    expect(templateHref("成都", 3, [])).not.toContain("prefs");
  });
});
