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

let lastUserMsg = "";

// 从 user 消息解析请求天数（prompt 形如「- 天数：N 天」）。
// planner 现在会核对「输出天数 === 请求天数」，桩不能再一律返回 3 天
// fixture——否则 1 天/4 天的请求会被判结构不符而失败。
// 少于 fixture 天数取前 N 天；多于则循环补齐（桩只测结构，内容复用无妨）。
function planForRequestedDays(userMsg) {
  const m = userMsg.match(/天数：(\d+)\s*天/);
  const n = m ? Number(m[1]) : CANNED_PLAN.days.length;
  if (!Number.isInteger(n) || n < 1 || n === CANNED_PLAN.days.length) return CANNED_PLAN;
  const days = [];
  for (let i = 0; i < n; i++) {
    const src = CANNED_PLAN.days[Math.min(i, CANNED_PLAN.days.length - 1)];
    days.push({ ...src, day: i + 1, spots: src.spots.map((s) => ({ ...s })) });
  }
  return { ...CANNED_PLAN, days };
}

// 乱序 + 跳号响应：数组顺序 [Day2, Day3, Day1]，day 字段 [5, 9, 2]。
// planner 归一化（按 day 排序 + 重编号 1..N）后应还原成与 fixture 完全
// 一致的结果——用来证明乱序/0 基/跳号输出不会被渲染成错乱行程。
function scrambledPlan() {
  return {
    ...CANNED_PLAN,
    days: [
      { ...CANNED_PLAN.days[1], day: 5 },
      { ...CANNED_PLAN.days[2], day: 9 },
      { ...CANNED_PLAN.days[0], day: 2 },
    ],
  };
}

// ---------- 分日流式（≥5 天）的桩响应 ----------
// 两次调用靠 system prompt 区分：大纲调用含「行程大纲」，单日调用含
// 「某一天的时刻表」。天数同样按请求适配（见 planForRequestedDays 注释）。

function outlineForRequestedDays(userMsg) {
  const m = userMsg.match(/天数：(\d+)\s*天/);
  const n = m ? Number(m[1]) : CANNED_PLAN.days.length;
  const days = [];
  for (let i = 0; i < n; i++) {
    const src = CANNED_PLAN.days[Math.min(i, CANNED_PLAN.days.length - 1)];
    days.push({
      day: i + 1,
      theme: src.theme,
      area: src.spots[0]?.area ?? "测试区",
      focus: `第 ${i + 1} 天的安排思路（桩数据）`,
    });
  }
  return { city: CANNED_PLAN.city, summary: CANNED_PLAN.summary, days, tips: CANNED_PLAN.tips ?? [] };
}

function dayForRequested(userMsg) {
  // day prompt 形如「现在生成行程中第 N 天的时刻表（共 M 天，这是第 K 天）」
  const m = userMsg.match(/第 (\d+) 天的时刻表（共 (\d+) 天/);
  const dayNum = m ? Number(m[1]) : 1;
  const src = CANNED_PLAN.days[Math.min(dayNum - 1, CANNED_PLAN.days.length - 1)];
  let spots = src.spots.map((s) => ({ ...s }));
  // 住宿只应出现在第一天：循环补齐时第 4/5 天会复用 fixture 的第 1 天，
  // 把酒店 spot 剔掉，避免桩数据自相矛盾
  if (dayNum > 1) spots = spots.filter((s) => s.type !== "hotel");
  return { day: dayNum, theme: src.theme, spots };
}

// 单日响应的延迟（毫秒）：分日流式的核心价值是「逐天出现」，桩若秒回，
// 整个任务瞬间完成，e2e 根本无法观测中间状态。测试编排器通过环境变量
// 注入延迟，让渐进式交付可被断言。
const DAY_DELAY_MS = Number(process.env.STUB_DAY_DELAY_MS || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 测试用：查看最近一次收到的 user 消息（验证输入确实拼进了 prompt）
  if (req.method === "GET" && url.pathname === "/_last_user") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user: lastUserMsg }));
    return;
  }

  if (req.method !== "POST" || !url.pathname.includes("/chat/completions")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    let userMsg = "";
    let systemMsg = "";
    let isStream = false;
    try {
      const parsed = JSON.parse(body);
      userMsg = parsed.messages?.filter((m) => m.role === "user").map((m) => m.content).join("\n") ?? "";
      systemMsg = parsed.messages?.filter((m) => m.role === "system").map((m) => m.content).join("\n") ?? "";
      lastUserMsg = userMsg;
      isStream = parsed.stream === true;
    } catch { /* 空 body 按 valid 处理 */ }

    // 分日流式的两次调用靠 system prompt 区分
    const isOutlineCall = systemMsg.includes("行程大纲");
    const isDayCall = systemMsg.includes("某一天的时刻表");

    let mode = "valid";
    if (userMsg.includes("垃圾")) mode = "garbage";
    else if (userMsg.includes("空")) mode = "empty";
    else if (userMsg.includes("故障")) mode = "http500";
    else if (userMsg.includes("编号乱序")) mode = "scrambled";
    else if (userMsg.includes("天数错")) mode = "wrongdays";
    // 单日阶段故障：第 2 天起返回垃圾（测「已生成几天后中途失败 → 任务 error + 退还配额」）。
    // 触发词刻意避开「故障」——那个词会被上面的 http500 模式先截走，
    // 导致大纲阶段就失败，测不到「中途」失败。
    else if (isDayCall && userMsg.includes("单日坏")) {
      const dm = userMsg.match(/第 (\d+) 天的时刻表/);
      if (dm && Number(dm[1]) >= 2) mode = "garbage";
    }
    console.log(`[stub] ${mode}${isOutlineCall ? " (outline)" : ""}${isDayCall ? " (day)" : ""}${isStream ? " (stream)" : ""}`);

    if (mode === "http500") {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub internal error" } }));
      return;
    }

    // 单日响应走延迟：让渐进式交付在 e2e 里可被观测（见 DAY_DELAY_MS 注释）
    if (isDayCall && DAY_DELAY_MS > 0 && mode !== "garbage") await sleep(DAY_DELAY_MS);

    const content =
      mode === "garbage" ? "抱歉，我不知道怎么回答这个问题。"
      : mode === "empty" ? ""
      : mode === "scrambled" ? JSON.stringify(scrambledPlan())
      // 无视请求天数，恒返回 3 天：测「结构不符 → 带纠正指令重试 → 仍不符 → 明确报错」
      : mode === "wrongdays" ? JSON.stringify(CANNED_PLAN)
      : isOutlineCall ? JSON.stringify(outlineForRequestedDays(userMsg))
      : isDayCall ? JSON.stringify(dayForRequested(userMsg))
      : JSON.stringify(planForRequestedDays(userMsg));

    if (isStream) {
      // SSE：模拟真实流式（role 帧 → 内容分两帧 → 结束帧带 usage）
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = (delta, finishReason, usage) => {
        const payload = { id: "stub-1", object: "chat.completion.chunk",
          choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
        if (usage) payload.usage = usage;
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      chunk({ role: "assistant" }, null);
      if (content) {
        const mid = Math.floor(content.length / 2);
        chunk({ content: content.slice(0, mid) }, null);
        chunk({ content: content.slice(mid) }, null);
      }
      chunk({}, "stop", { prompt_tokens: 10, completion_tokens: content.length, total_tokens: 20 + content.length });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

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
