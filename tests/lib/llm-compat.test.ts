import type OpenAI from "openai";
import { afterEach, expect, it, vi } from "vitest";
import { streamChatRetry } from "@/lib/plan/planner";

afterEach(() => vi.unstubAllEnvs());

it.each([
  [undefined, "low"],
  ["off", undefined],
  ["high", "high"],
])("推理选项 %s 发送 %s", async (effort, expected) => {
  vi.stubEnv("LLM_REASONING_EFFORT", effort);
  const create = vi.fn(async function* () {
    yield { choices: [{ delta: { content: "{}" } }] };
    yield { choices: [], usage: { total_tokens: 42 } };
  });
  const llm = { chat: { completions: { create } } } as unknown as OpenAI;

  await expect(streamChatRetry(llm, "系统", "输入", "苏州")).resolves.toEqual({
    content: "{}",
    tokens: 42,
  });
  const request = (create.mock.calls as unknown[][])[0][0];
  if (expected === undefined) expect(request).not.toHaveProperty("reasoning_effort");
  else expect(request).toHaveProperty("reasoning_effort", expected);
});
