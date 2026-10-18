import { describe, expect, it } from "vitest";
import { cityImage, generatedCityImage } from "@/lib/city-images";

// 背景图机制：已核实城市用真图，其余任意城市/地区用确定性生成的暗色渐变图，
// 彻底干掉"选京都却显示长城"的张冠李戴。钉住这几条契约。

const DATA_PREFIX = "data:image/svg+xml,";
const decode = (uri: string) => decodeURIComponent(uri.slice(DATA_PREFIX.length));

describe("cityImage 城市背景", () => {
  it("已核实实拍图的城市返回 Wikimedia 真图", () => {
    expect(cityImage("成都")).toContain("wikimedia.org");
    expect(cityImage("成都")).toContain("Chengdu");
    expect(cityImage("苏州")).toContain("Suzhou");
  });

  it("未覆盖的任意城市返回生成的 data-URI SVG（不再是长城兜底图）", () => {
    const img = cityImage("京都");
    expect(img.startsWith(DATA_PREFIX)).toBe(true);
    const svg = decode(img);
    expect(svg).toContain("<svg");
    expect(svg).toContain("linearGradient");
    expect(svg).toContain("radialGradient");
    expect(svg).toMatch(/hsl\(/); // 用 HSL 色相
  });

  it("确定性：同一名字每次生成同一张", () => {
    expect(cityImage("京都")).toBe(cityImage("京都"));
    expect(generatedCityImage("北京")).toBe(generatedCityImage("北京"));
  });

  it("不同城市不全同一张（色相/方向/光晕有差异）", () => {
    const gen = ["京都", "北京", "大理", "哈尔滨", "丽江", "三亚", "大阪", "首尔"]
      .map(generatedCityImage);
    expect(new Set(gen).size).toBeGreaterThan(1);
  });

  it("地区名（区域环线）也能生成，不抛错", () => {
    expect(() => cityImage("川西环线")).not.toThrow();
    expect(cityImage("川西环线").startsWith(DATA_PREFIX)).toBe(true);
  });

  it("空字符串也走生成（首页初始/未选城市不崩）", () => {
    expect(() => cityImage("")).not.toThrow();
    expect(cityImage("").startsWith(DATA_PREFIX)).toBe(true);
  });

  it("生成图是 data-URI，无外部图片依赖（断网也能显示）", () => {
    const img = generatedCityImage("京都");
    expect(img.startsWith("data:")).toBe(true);
    // 注意：SVG 内含 xmlns='http://www.w3.org/2000/svg'（命名空间，非网络请求），
    // 所以判据是「不引用外部图床/照片 URL」，而非整个字符串不含 http。
    expect(img).not.toContain("wikimedia");
    expect(img).not.toContain("/thumb/");
    expect(img).not.toContain(".jpg");
    expect(img).not.toContain(".png");
  });

  it("data-URI 可被解码回合法 SVG（#/% 等编码正确）", () => {
    const svg = decode(generatedCityImage("京都"));
    // 关键：# 号在 fill 里必须能还原（encodeURIComponent 把 # 编成 %23）
    expect(svg).toContain("fill='#0b0b12'");
    expect(svg).toContain("fill='url(#b)'");
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
  });
});
