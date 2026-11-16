import { describe, expect, it } from "vitest";
import { longestCommonSubstring, matchSpotName, nameCovered } from "@/lib/plan/name-match";

// name-match.ts 是全项目名称匹配的唯一来源（ADR-020 · R5）。三份旧实现
// （schedule/replan/validate）钉的是同一组样本，这里必须全绿。

describe("matchSpotName（锚点/行程点同名判定）", () => {
  it("简称 ↔ 全称：公共子串 ≥3 字即命中", () => {
    expect(matchSpotName("川剧变脸", "蜀风雅韵川剧变脸演出(琴台路店)")).toBe(true);
    expect(matchSpotName("成都大熊猫基地", "成都大熊猫繁育研究基地")).toBe(true);
  });

  it("双向完整包含即命中", () => {
    expect(matchSpotName("武侯祠", "武侯祠")).toBe(true);
    expect(matchSpotName("成都武侯祠博物馆", "武侯祠")).toBe(true);
  });

  it("公共子串不足 3 字 → 不命中（防止误报）", () => {
    expect(matchSpotName("测试必游地X", "成都大熊猫繁育研究基地")).toBe(false);
  });

  it("空值 → false", () => {
    expect(matchSpotName("", "武侯祠")).toBe(false);
    expect(matchSpotName("武侯祠", "")).toBe(false);
  });
});

describe("nameCovered（必游地/住所覆盖判定）", () => {
  it("列表里任一候选命中即算覆盖", () => {
    expect(nameCovered("武侯祠", ["锦里古街", "成都武侯祠博物馆"])).toBe(true);
    expect(nameCovered("成都大熊猫基地", ["成都大熊猫繁育研究基地", "宽窄巷子"])).toBe(true);
  });

  it("列表都没覆盖 → false", () => {
    expect(nameCovered("武侯祠", ["锦里古街", "宽窄巷子"])).toBe(false);
  });

  it("空名字 → false（没有「无名必游地」）", () => {
    expect(nameCovered("", ["武侯祠"])).toBe(false);
  });
});

describe("longestCommonSubstring", () => {
  it("基本情形", () => {
    expect(longestCommonSubstring("abcdef", "zzcdefzz")).toBe(4); // "cdef"
    expect(longestCommonSubstring("abc", "xyz")).toBe(0);
    expect(longestCommonSubstring("", "abc")).toBe(0);
  });
});
