#!/usr/bin/env node
/**
 * 桩 LLM 服务（测试专用）：模拟 LLM 的各种行为。
 *
 * 按请求里「目的地：X」的城市名分支：
 *   含"垃圾" -> 返回非 JSON 文本（测 parse 重试路径）
 *   含"空"   -> 返回空 content（测空返回重试路径）
 *   含"故障" -> 直接 HTTP 500（测上游错误路径）
 *   其他     -> 返回构造好的合法行程（测正常链路 + 体检阈值）
 *
 * 用法：node scripts/stub-llm.mjs [port]   （默认 8898）
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.argv[2] || process.env.STUB_PORT || 8898);

// 正常模式返回的真实行程 fixture：来自一次真实生成的「苏州 3 天」结果
// （day.transitMin / dailyCostCny 是 validate 回填字段，LLM 输出层不带）
const CANNED_PLAN = JSON.parse(
  readFileSync(new URL("./fixture-plan.json", import.meta.url), "utf8"),
);

const server = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let userMsg = "";
    try {
      const parsed = JSON.parse(body);
      userMsg = parsed.messages?.filter((m) => m.role === "user").map((m) => m.content).join("\n") ?? "";
    } catch { /* 空 body 按 valid 处理 */ }

    let mode = "valid";
    if (userMsg.includes("垃圾")) mode = "garbage";
    else if (userMsg.includes("空")) mode = "empty";
    else if (userMsg.includes("故障")) mode = "http500";
    console.log(`[stub] ${mode}`);

    if (mode === "http500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub internal error" } }));
      return;
    }

    const content =
      mode === "garbage" ? "抱歉，我不知道怎么回答这个问题。"
      : mode === "empty" ? ""
      : JSON.stringify(CANNED_PLAN);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "stub-1",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[stub] listening on http://127.0.0.1:${PORT}`);
});
