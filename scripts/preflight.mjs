#!/usr/bin/env node
/**
 * 上线预检：部署日跑一遍，把 15 轮踩过的坑变成一条命令的 GO/NO-GO。
 *
 *   npm run preflight        # 会自动加载 .env
 *
 * 检查项分两级：❌ BLOCK（不修复不能上线）/ ⚠️ WARN（能用但有隐患）
 */
import { readFileSync, existsSync } from "node:fs";

const checks = [];
function check(level, name, ok, detail = "") {
  checks.push({ level, name, ok, detail });
}

function env(name) {
  return process.env[name];
}

// 1. Node 版本（engines 已约束 >=20，SDK/Next 都需要）
const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
check("BLOCK", "Node.js >= 20", nodeOk, `当前 ${process.version}`);

// 2. LLM 必需配置
check("BLOCK", "LLM_API_KEY 已配置", Boolean(env("LLM_API_KEY")) && env("LLM_API_KEY").length > 10);
check("BLOCK", "LLM_BASE_URL 是 https", (env("LLM_BASE_URL") ?? "").startsWith("https://"),
  env("LLM_BASE_URL") || "未设置（默认 stepfun 网关）");
check("WARN", "LLM_MODEL 已设置", Boolean(env("LLM_MODEL")), env("LLM_MODEL") || "未设置");

// 3. 高德（缺失 = MOCK 模式，POI 不验真，产品核心卖力缺失）
const amapKey = env("AMAP_WEB_SERVICE_KEY");
check("WARN", "AMAP_WEB_SERVICE_KEY 已配置", Boolean(amapKey),
  amapKey ? "live 验真模式" : "未配置 → MOCK 模式，行程 POI 不验真（verified=false）");

// 4. 生产环境的 session 密钥（默认值是公开的，等于没签名）
if ((env("NODE_ENV") ?? "") === "production") {
  const secret = env("SESSION_SECRET");
  check("BLOCK", "SESSION_SECRET 已修改（生产）",
    Boolean(secret) && secret !== "dev-only-insecure-secret",
    "用随机长字符串，如 openssl rand -hex 32");
}
check("WARN", "COOKIE_SECURE 生产应为 1/unset（自动 https）",
  env("COOKIE_SECURE") !== "0", "COOKIE_SECURE=0 会让 session cookie 在 http 也发送");

// 5. 配额数字合法（未设置则用代码默认值 3 / 10，合法）
const DEFAULTS = { DAILY_FREE_LIMIT: 3, AUTH_USER_LIMIT: 10 };
for (const [name, min, max] of [["DAILY_FREE_LIMIT", 1, 1000], ["AUTH_USER_LIMIT", 1, 1000]]) {
  const raw = env(name);
  const v = raw === undefined || raw === "" ? DEFAULTS[name] : Number(raw);
  check("BLOCK", `${name} 是 ${min}-${max} 的整数`,
    Number.isInteger(v) && v >= min && v <= max,
    raw === undefined || raw === "" ? `未设置 → 用默认 ${DEFAULTS[name]}` : `当前 ${raw}`);
}

// 6. .env 不会被提交（密钥泄漏防线）
const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
check("BLOCK", ".gitignore 包含 .env", gitignore.includes(".env"));

// 7. 构建产物存在（standalone）
check("WARN", "已执行 npm run build", existsSync(".next/standalone/server.js"),
  "部署前必须构建；standalone 需 cp static 与 public（见 DEPLOY.md）");

// ---- 汇总 ----
let blocked = 0;
let warned = 0;
for (const c of checks) {
  if (c.ok) {
    console.log(`✅ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  } else if (c.level === "BLOCK") {
    blocked += 1;
    console.log(`❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  } else {
    warned += 1;
    console.log(`⚠️  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
}

console.log(`\n${blocked === 0 ? "🟢 GO" : "🔴 NO-GO"}：${blocked} 个阻断项，${warned} 个警告`);
if (blocked > 0) {
  console.log("修复阻断项后重试；警告项按业务判断。");
  process.exitCode = 1;
}
