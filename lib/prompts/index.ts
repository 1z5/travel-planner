// Prompt 注册中心 — 所有 LLM prompt 的统一入口
//
// 为什么需要这个文件：prompt 散落在各模块里，agent 改了一个不知道影响哪些。
// 集中注册后：(1) 改 prompt 有单一入口 (2) 版本号可追踪 (3) 单测可钉住内容
//
// 版本号规则：prompt 内容变更时 +1（语义变更 +1，措辞优化 +0.1）

export const PROMPT_VERSIONS = {
  // 3.0.0：事实先行——生成前注入高德真实素材清单（名称/营业时间/闭馆日已核验），
  // 行程点优先从清单选，闭馆日与营业时间变成硬约束。
  planner: "3.0.0", // 行程生成（单次 + 大纲 + 分日）
  refine: "1.2.0", // 改行程（换一个 / 一句话改 / 一键修复）
  copilot: "1.0.0", // 行程管家（step-5 对话）
} as const;

// 重新导出各模块的 prompt（保持单一来源，不在本文件复制内容）
export {
  SYSTEM_PROMPT,
  DAY_SYSTEM_PROMPT,
  OUTLINE_SYSTEM_PROMPT,
  baseLines,
  PACE_RULES,
} from "../planner";
export { REFINE_MARK, buildRefinePrompt } from "../refine";
export { ANSWER_RULES, COPILOT_MARK } from "../copilot";
