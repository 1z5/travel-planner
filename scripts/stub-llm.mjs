#!/usr/bin/env node
/**
 * 桩 LLM 服务（测试专用）：模拟 LLM 的各种行为。
 *
 * 按请求里「目的地：X」的城市名分支：
 *   含"垃圾" -> 返回非 JSON 文本（测 parse 重试路径）
 *   含"空"   -> 返回空 content（测空返回重试路径）
 *   含"500"  -> 直接 HTTP 500（测上游错误路径）
 *   其他     -> 返回构造好的合法行程（测正常链路 + 体检阈值）
 *
 * 用法：node scripts/stub-llm.mjs [port]   （默认 8898）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] || process.env.STUB_PORT || 8898);

// 精心构造的测试行程：第一天超长（触发节奏预警）、第三天超贵（触发预算预警）
const CANNED_PLAN = {
  city: "成都",
  summary: "桩服务测试行程",
  days: [
    {
      day: 1,
      theme: "高强度测试日",
      spots: [
        ["morning", "09:00-10:00", "sight", "测试景点A", 300, 10],
        ["afternoon", "10:00-11:00", "sight", "测试景点B", 300, 10],
        ["dinner", "11:00-12:00", "food", "测试餐厅C", 90, 10],
        ["evening", "19:00-20:00", "sight", "测试景点D", 120, 10],
      ].map(([period, time, type, name, durationMin, costCny]) => ({
        period, time, type, name, area: "测试区", durationMin, costCny, reason: "占位",
      })),
    },
    {
      day: 2,
      theme: "普通日",
      spots: [
        { period: "morning", time: "09:00-11:00", type: "sight",
          name: "测试景点E", area: "测试区", durationMin: 120, costCny: 10, reason: "占位" },
      ],
    },
    {
      day: 3,
      theme: "超预算日",
      spots: [
        { period: "morning", time: "09:00-11:00", type: "sight",
          name: "测试景点F", area: "测试区", durationMin: 120, costCny: 600, reason: "占位" },
        { period: "dinner", time: "18:00-19:30", type: "food",
          name: "测试餐厅G", area: "测试区", durationMin: 90, costCny: 600, reason: "占位" },
      ],
    },
  ],
  totalCostCny: 0,
  tips: ["桩服务提示：这是自动化测试数据"],
};

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
    else if (userMsg.includes("500")) mode = "http500";
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
