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
 *      DATA_STORE 与 DATABASE_URL、NEXT_PUBLIC_SITE_URL 成对/格式校验；
 *   3. 安全检查：生产模式下 SESSION_SECRET 仍为开发默认值、AUTH_PROVIDER=none → BLOCK。
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
// 对外绝对地址：app/layout.tsx 的 metadataBase 读它；生产缺省 → 分享页 OG/绝对链接指 localhost
if (has("NEXT_PUBLIC_SITE_URL")) {
  const site = env.NEXT_PUBLIC_SITE_URL.trim();
  add("BLOCK", "NEXT_PUBLIC_SITE_URL 是 https 绝对地址", /^https:\/\//.test(site), site);
} else {
  add(
    "WARN",
    "NEXT_PUBLIC_SITE_URL 未配置 → 分享页 OG 图/绝对链接会指 localhost（生产必填）",
    true,
  );
}

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

// 存储一致性：DATA_STORE 与 DATABASE_URL 必须成对出现——只配一半就是静默降级
// （DATA_STORE=postgres 缺 URL → 启动即崩；配了 URL 却忘了 DATA_STORE → 悄悄跑内存，
// 重启丢分享链接、配额归零，却是本地绿的环境）。
const storeMode = (env.DATA_STORE ?? "memory").trim();
const dbUrl = (env.DATABASE_URL ?? "").trim();
const dbUrlOk = /^(postgres|postgresql):\/\//.test(dbUrl);
if (storeMode === "postgres") {
  add(
    "BLOCK",
    "DATA_STORE=postgres 时 DATABASE_URL 必填且为 postgres 协议",
    dbUrl !== "" && dbUrlOk,
    !dbUrl ? "缺少 DATABASE_URL" : dbUrlOk ? "" : "协议不是 postgres://",
  );
} else {
  add("WARN", "DATA_STORE=memory（未设置时默认）→ 重启丢 Plan/配额归零；生产必须 postgres", true);
  add(
    "WARN",
    "使用 memory 时 DATABASE_URL 应为空（否则容易误以为已持久化）",
    dbUrl === "",
    dbUrl ? "配了 DATABASE_URL 但 DATA_STORE 不是 postgres" : "",
  );
}

const isProd = (env.NODE_ENV ?? "").trim() === "production";
if (isProd) {
  add(
    "BLOCK",
    "生产环境 SESSION_SECRET 不是开发默认值",
    has("SESSION_SECRET") && env.SESSION_SECRET !== "dev-only-insecure-secret",
  );
  add("BLOCK", "生产环境 DATA_STORE 不是 memory", storeMode !== "memory");
  // 生产 none = 固定验证码 123456 可登录任意手机号（P0-1）
  const provider = (env.AUTH_PROVIDER ?? "none").trim();
  const allowDevAuth = (env.ALLOW_DEV_AUTH ?? "").trim() === "1";
  add(
    "BLOCK",
    "生产环境 AUTH_PROVIDER 不是 none（或显式 ALLOW_DEV_AUTH=1）",
    provider !== "none" || allowDevAuth,
    provider !== "none"
      ? ""
      : allowDevAuth
        ? "ALLOW_DEV_AUTH=1 显式允许 dev provider（仅预发/内部演示）"
        : "当前 none：任意手机号可用固定验证码登录",
  );
}

// 指标看板：没有 token 时 /api/events/summary 一律 404（可用，但北极星不可见）
add(
  "WARN",
  "METRICS_TOKEN 已配置（指标看板可用）",
  has("METRICS_TOKEN"),
  "未配置 → 看板一律 404：漏斗/北极星指标不可见（不影响主流程）",
);

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
