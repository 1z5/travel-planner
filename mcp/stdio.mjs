#!/usr/bin/env node
// ============================================================
// Trip Check MCP 的本地 stdio 桥（零依赖 · 串行 · 换行分隔 JSON-RPC 2.0）
//
// 为什么需要它：MCP 客户端（Claude Desktop / Cursor / 自写 agent）用 stdio
// 起子进程说话，而 Trip Check 的服务是 HTTP（POST /api/mcp）。这个脚本只做
// 一件事：stdin 一行 = 一条 JSON-RPC 消息 → POST 给本地服务 → 把返回的 JSON
// 原样（重新序列化为一行）写回 stdout。
//
// 三条刻意的约束：
// 1) 零依赖：MCP 客户端用系统 node 直接起它，不能让用户为了一个桥先 npm install；
// 2) 串行（最多 1 个在途请求）：本地 `next dev` 冷启动/按需编译时并发请求会互相
//    排队、也更容易把 dev server 打爆；串行还能保持响应顺序可预测；
// 3) stdout 只写协议帧：诊断信息全部走 stderr。往 stdout 打一句「启动成功」就
//    会污染 JSON-RPC 流，客户端会解析失败——这是 stdio MCP 最常见的坑。
//
// 环境变量：
// - TRIP_CHECK_URL       服务基址（默认 http://127.0.0.1:3000；也可直接给 .../api/mcp）
// - TRIP_CHECK_TIMEOUT_MS 单请求超时（默认 60000；首次访问路由时 next dev 要按需编译）
// ============================================================

import { createInterface } from "node:readline";

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
/** JSON-RPC 服务自定义错误码区间 -32000..-32099；本桥用 -32001 表示「连不上/响应不可用」 */
const NETWORK_ERROR_CODE = -32001;
const REQUEST_TIMEOUT_MS = Number(process.env.TRIP_CHECK_TIMEOUT_MS) || 60_000;

/** 基址 → 端点。允许直接贴完整 /api/mcp（重复拼接会得到 404，排障成本高） */
function endpointOf(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return base.endsWith("/api/mcp") ? base : `${base}/api/mcp`;
}

const ENDPOINT = endpointOf(process.env.TRIP_CHECK_URL);

function writeRpc(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * 尽力从一行请求里取 id（网络错误时要带上 id，客户端才能把错误对到请求上）。
 * 输入不是合法 JSON 时按 JSON-RPC 规定用 null（检测不到 id）。
 */
function idOf(line) {
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const { id } = parsed;
      if (typeof id === "string" || typeof id === "number") return id;
    }
    return null;
  } catch {
    return null;
  }
}

function networkError(id, message) {
  return { jsonrpc: "2.0", id, error: { code: NETWORK_ERROR_CODE, message } };
}

/** 转发一条消息并把结果写回 stdout；任何失败都变成 JSON-RPC error（不抛错、不退出） */
async function forward(line) {
  const id = idOf(line);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: line,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeRpc(networkError(id, `无法连接 Trip Check 服务 ${ENDPOINT}：${reason}`));
    return;
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeRpc(networkError(id, `读取 Trip Check 响应失败（HTTP ${response.status}）：${reason}`));
    return;
  }

  // 通知（无 id）在服务端返回 202 空 body：stdio 侧同样不回应通知
  if (!text.trim()) return;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    writeRpc(networkError(id, `Trip Check 服务返回了非 JSON 响应（HTTP ${response.status}）`));
    return;
  }
  // 重新序列化：保证 stdout 严格「一条消息一行」（上游 body 若含换行会破坏帧）
  writeRpc(parsed);
}

// 父进程关掉 stdout 管道时安静退出：EPIPE 不是错误，打崩溃日志反而误导用户
process.stdout.on("error", (error) => {
  if (error && error.code === "EPIPE") process.exit(0);
});

process.stderr.write(`[trip-check-mcp] stdio bridge → POST ${ENDPOINT}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  await forward(trimmed);
}
