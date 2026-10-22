#!/usr/bin/env node
/**
 * 环境变量体检（给人和 AI 代理用，不改变运行时行为）
 *
 * 为什么需要：这个项目有 60+ 处 process.env 裸读，`lib/` 里又有大量
 * 「不配就降级」的分支。AI 代理改完代码后如果环境里某个变量拼错了，
 * 症状往往不是报错，而是**静默降级**（MOCK 模式 / 配额按默认值 / 模型名错），
 * 排查成本很高。这里做三件事：
 *   1. 格式校验：URL/整数/枚举类变量格式不对 → BLOCK；
 *   2. 一致性检查：.env 里设了但 .env.example 没写的变量 → WARN（文档漂移）；
 *   3. 安全检查：生产模式下 SESSION_SECRET 仍为开发默认值 → BLOCK。
 *
 * 用法：npm run check:env      （读取 .env；不存在则只检查 process.env）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".env");
const EXAMPLE = path.join(ROOT, ".env.example");

const checks = [];
const add = (level, name, ok, detail = "") => checks.push({ level, name, ok, detail });

// ---------- 读取 .env（简单 KEY=VALUE；不处理多行） ----------
const envFromFile = {};
if (fs.existsSync(ENV_FILE)) {
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m) envFromFile[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const env = { ...envFromFile, ...process.env };
const has = (k) => typeof env[k] === "string" && env[k].trim() !== "";
const int = (k) => /^\d+$/.test((env[k] ?? "").trim());
const url = (k) => {
  try {
    new URL(env[k]);
    return true;
  } catch {
    return false;
  }
};
const oneOf = (k, options) => options.includes((env[k] ?? "").trim());

// ---------- 1. 格式校验 ----------
add("BLOCK", "LLM_API_KEY 已配置（不配则无法生成）", has("LLM_API_KEY"));
if (has("LLM_BASE_URL"))
  add("BLOCK", "LLM_BASE_URL 是合法 URL", url("LLM_BASE_URL"), env.LLM_BASE_URL);
if (has("LLM_MAX_TOKENS"))
  add("BLOCK", "LLM_MAX_TOKENS 是整数", int("LLM_MAX_TOKENS"), env.LLM_MAX_TOKENS);
if (has("LLM_STREAM_DEADLINE_MS"))
  add(
    "BLOCK",
    "LLM_STREAM_DEADLINE_MS 是整数",
    int("LLM_STREAM_DEADLINE_MS"),
    env.LLM_STREAM_DEADLINE_MS,
  );
if (has("LLM_REASONING_EFFORT"))
  add(
    "BLOCK",
    "LLM_REASONING_EFFORT 在枚举内",
    oneOf("LLM_REASONING_EFFORT", ["off", "low", "medium", "high"]),
    env.LLM_REASONING_EFFORT,
  );
if (has("DAILY_FREE_LIMIT"))
  add("BLOCK", "DAILY_FREE_LIMIT 是整数", int("DAILY_FREE_LIMIT"), env.DAILY_FREE_LIMIT);
if (has("AUTH_USER_LIMIT"))
  add("BLOCK", "AUTH_USER_LIMIT 是整数", int("AUTH_USER_LIMIT"), env.AUTH_USER_LIMIT);
if (has("DATA_STORE"))
  add("BLOCK", "DATA_STORE 在枚举内", oneOf("DATA_STORE", ["memory", "postgres"]), env.DATA_STORE);
if (has("AUTH_PROVIDER"))
  add(
    "BLOCK",
    "AUTH_PROVIDER 在枚举内",
    oneOf("AUTH_PROVIDER", ["none", "sms", "wechat"]),
    env.AUTH_PROVIDER,
  );
if (has("AMAP_BASE_URL"))
  add("BLOCK", "AMAP_BASE_URL 是合法 URL", url("AMAP_BASE_URL"), env.AMAP_BASE_URL);

// 数值型限流（可选，设了就要是整数）
for (const k of [
  "REFINE_HOURLY_LIMIT",
  "ADJUST_HOURLY_LIMIT",
  "COPILOT_HOURLY_LIMIT",
  "REPLAN_HOURLY_LIMIT",
  "JOB_STALE_MS",
]) {
  if (has(k)) add("BLOCK", `${k} 是整数`, int(k), env[k]);
}

// ---------- 2. 语义/一致性 ----------
add("WARN", "LLM_MODEL 已设置（空则用代码默认）", has("LLM_MODEL"), env.LLM_MODEL || "未设置");
if (!has("AMAP_WEB_SERVICE_KEY")) {
  add("WARN", "AMAP_WEB_SERVICE_KEY 未配置 → 全链路 MOCK（POI 不验真、无事实清单）", true);
} else {
  add(
    "BLOCK",
    "AMAP_WEB_SERVICE_KEY 长度合理（高德 key 为 32 位）",
    env.AMAP_WEB_SERVICE_KEY.length >= 28,
  );
}

const isProd = (env.NODE_ENV ?? "").trim() === "production";
if (isProd) {
  add(
    "BLOCK",
    "生产环境 SESSION_SECRET 不是开发默认值",
    has("SESSION_SECRET") && env.SESSION_SECRET !== "dev-only-insecure-secret",
  );
  add("BLOCK", "生产环境 DATA_STORE 不是 memory", (env.DATA_STORE ?? "memory") !== "memory");
}

// .env.example 文档漂移：设了但没写进示例的变量（AI 代理最容易漏文档）
const exampleKeys = new Set(
  fs.existsSync(EXAMPLE)
    ? fs
        .readFileSync(EXAMPLE, "utf8")
        .split("\n")
        .map((l) => /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/.exec(l)?.[1])
        .filter(Boolean)
    : [],
);
const undocumented = Object.keys(envFromFile).filter((k) => !exampleKeys.has(k));
add(
  "WARN",
  ".env 中的变量全部在 .env.example 有记载（防文档漂移）",
  undocumented.length === 0,
  undocumented.join(", "),
);

// ---------- 输出 ----------
let failed = 0;
let warned = 0;
console.log("\n环境变量体检（只读，不改变运行时）\n");
for (const c of checks) {
  if (c.ok) {
    console.log(`  ✅ ${c.name}`);
  } else if (c.level === "BLOCK") {
    failed += 1;
    console.log(`  ❌ ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
  } else {
    warned += 1;
    console.log(`  ⚠️  ${c.name}${c.detail ? `（${c.detail}）` : ""}`);
  }
}
console.log(`\n结果：${failed} 个阻断 / ${warned} 个警告\n`);
if (failed > 0) process.exitCode = 1;
