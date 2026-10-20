import { describe, expect, it } from "vitest";
import {
  PROMPT_VERSIONS,
  SYSTEM_PROMPT,
  DAY_SYSTEM_PROMPT,
  OUTLINE_SYSTEM_PROMPT,
  REFINE_MARK,
  ANSWER_RULES,
  COPILOT_MARK,
} from "@/lib/prompts";

// Prompt 稳定性测试：prompt 是 LLM 行为的核心，无意修改会导致输出回归。
// 这些测试钉住关键 prompt 的核心特征（不是全文快照，避免措辞优化就失败）。

describe("Prompt 注册中心", () => {
  it("版本号存在且格式正确", () => {
    expect(PROMPT_VERSIONS.planner).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROMPT_VERSIONS.refine).toMatch(/^\d+\.\d+\.\d+$/);
    expect(PROMPT_VERSIONS.copilot).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("planner prompt 包含核心约束（结构化 JSON + 不编造）", () => {
    expect(SYSTEM_PROMPT).toContain("只输出一个合法 JSON");
    expect(SYSTEM_PROMPT).toContain("POI 名称（必须真实存在）");
    expect(DAY_SYSTEM_PROMPT).toContain("只输出一个合法 JSON");
    expect(OUTLINE_SYSTEM_PROMPT).toContain("只输出一个合法 JSON");
  });

  it("refine prompt 标记词存在（桩 LLM 靠它识别）", () => {
    expect(REFINE_MARK).toBe("行程微调");
  });

  it("copilot prompt 包含诚实准则（只依据事实、不编造）", () => {
    expect(COPILOT_MARK).toBe("行程管家");
    expect(ANSWER_RULES).toContain("只基于");
    expect(ANSWER_RULES).toContain("不要用你记忆里的");
    expect(ANSWER_RULES).toContain("拿不准就明确说不知道");
  });

  it("copilot prompt 要求结构化 JSON 输出", () => {
    expect(ANSWER_RULES).toContain("只输出一个合法 JSON");
    expect(ANSWER_RULES).toContain("suggestion");
  });
});
