import { describe, expect, it } from "vitest";
import { BRAND_BACKGROUND, cityImage } from "@/lib/city-images";

// 背景图已从「按城市切换」改为「系统固定」。这些用例钉住新契约：
// 任何输入都返回同一张固定背景、是合法 data-URI SVG、无外部图床依赖。

const DATA_PREFIX = "data:image/svg+xml,";
const decode = (uri: string) => decodeURIComponent(uri.slice(DATA_PREFIX.length));

describe("固定背景图", () => {
  it("任何城市都返回同一张固定背景（不再按城市切换）", () => {
    expect(cityImage("成都")).toBe(BRAND_BACKGROUND);
    expect(cityImage("京都")).toBe(BRAND_BACKGROUND);
    expect(cityImage("川西环线")).toBe(BRAND_BACKGROUND);
    expect(cityImage("")).toBe(BRAND_BACKGROUND);
    // 关键：不同城市不再产生不同背景
    expect(cityImage("北京")).toBe(cityImage("上海"));
  });

  it("是合法的 data-URI SVG（含渐变定义）", () => {
    expect(BRAND_BACKGROUND.startsWith(DATA_PREFIX)).toBe(true);
    const svg = decode(BRAND_BACKGROUND);
    expect(svg).toContain("<svg");
    expect(svg).toContain("linearGradient");
    expect(svg).toContain("radialGradient");
    expect(svg).toMatch(/hsl\(|#/); // 有实际填色
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });

  it("无外部图床依赖（不含 wikimedia/外链图片 URL，断网也能显示）", () => {
    expect(BRAND_BACKGROUND).not.toContain("wikimedia");
    expect(BRAND_BACKGROUND).not.toContain("/thumb/");
    expect(BRAND_BACKGROUND).not.toContain(".jpg");
    expect(BRAND_BACKGROUND).not.toContain(".png");
    // data-URI 里唯一出现的 http 是 SVG 的 xmlns 命名空间，不是网络请求
    const svg = decode(BRAND_BACKGROUND);
    expect(svg.match(/http/g) ?? []).toHaveLength(1);
    expect(svg).toContain("xmlns='http://www.w3.org/2000/svg'");
  });

  it("确定性：固定背景本身不变", () => {
    expect(cityImage("成都")).toBe(cityImage("成都"));
    expect(BRAND_BACKGROUND).toBe(BRAND_BACKGROUND);
  });

  it("任意奇怪输入都不抛错", () => {
    expect(() => cityImage("")).not.toThrow();
    expect(() => cityImage("🌟")).not.toThrow();
    expect(() => cityImage("a".repeat(200))).not.toThrow();
  });
});
