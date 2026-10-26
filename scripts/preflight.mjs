#!/usr/bin/env node
/**
 * 上线预检：部署日跑一遍，把 15 轮踩过的坑变成一条命令的 GO/NO-GO。
 *
 *   npm run preflight        # 会自动加载 .env
 *
 * 检查项分两级：❌ BLOCK（不修复不能上线）/ ⚠️ WARN（能用但有隐患）
 *
 * 注意：这是**部署期**的门，不假设 NODE_ENV 已被设成 production
 * （裸 shell 里 NODE_ENV 往往是空的，而 next start / standalone 才自动设为
 * production）。所以 AUTH_PROVIDER/SESSION_SECRET/存储这些生产硬要求在这里
 * 一律无条件检查，避免「本地 shell 跑出 GO、容器里却是 memory + 假登录」。
 */
import { readFileSync, existsSync } from "node:fs";

const checks = [];
function check(level, name, ok, detail = "") {
  checks.push({ level, name, ok, detail });
}

function env(name) {
  return process.env[name];
}

const trimmed = (name) => (env(name) ?? "").trim();

// 1. Node 版本（engines 已约束 >=20，SDK/Next 都需要）
const nodeOk = Number(process.versions.node.split(".")[0]) >= 20;
check("BLOCK", "Node.js >= 20", nodeOk, `当前 ${process.version}`);

// 2. LLM 必需配置
check("BLOCK", "LLM_API_KEY 已配置", Boolean(env("LLM_API_KEY")) && env("LLM_API_KEY").length > 10);
check(
  "BLOCK",
  "LLM_BASE_URL 是 https",
  (env("LLM_BASE_URL") ?? "").startsWith("https://"),
  env("LLM_BASE_URL") || "未设置（默认 stepfun 网关）",
);
check("WARN", "LLM_MODEL 已设置", Boolean(env("LLM_MODEL")), env("LLM_MODEL") || "未设置");

// 3. 高德（缺失 = MOCK 模式，POI 不验真，产品核心卖力缺失）
const amapKey = env("AMAP_WEB_SERVICE_KEY");
check(
  "WARN",
  "AMAP_WEB_SERVICE_KEY 已配置",
  Boolean(amapKey),
  amapKey ? "live 验真模式" : "未配置 → MOCK 模式，行程 POI 不验真（verified=false）",
);

// 4. 存储（P0-2）：默认 memory = 重启丢 Plan（分享链接 404）、配额归零、多副本各算各的
// 与产品承诺「分享链接长期有效」直接矛盾，所以必须 BLOCK 而不是 WARN。
const dataStore = trimmed("DATA_STORE");
check(
  "BLOCK",
  "DATA_STORE=postgres（生产必须持久化）",
  dataStore === "postgres",
  dataStore === "postgres"
    ? "已配置持久化存储（分享链接长期有效）"
    : dataStore
      ? `当前 ${dataStore}：重启丢 Plan（分享链接 404）、配额归零、多副本各算各的`
      : "未设置（代码默认 memory）：重启丢 Plan（分享链接 404）、配额归零",
);

// 5. 数据库连接串：Prisma 7 + @prisma/adapter-pg 只认 postgres 协议
const dbUrl = trimmed("DATABASE_URL");
const dbProtocolOk = /^(postgres|postgresql):\/\//.test(dbUrl);
check(
  "BLOCK",
  "DATABASE_URL 是 postgres 连接串",
  dbUrl !== "" && dbProtocolOk,
  !dbUrl
    ? "DATA_STORE=postgres 时必填，如 postgres://user:pass@host:5432/db"
    : dbProtocolOk
      ? "已配置（不要在仓库/镜像里留真实连接串）"
      : "协议不是 postgres://（adapter-pg 不接受）",
);

// 6. 对外绝对地址（P0-6）：app/layout.tsx 的 metadataBase 读它，
// 缺省时分享页 OG/Twitter 卡片与绝对链接全部指向 localhost = 对外分享是坏的。
const siteUrl = trimmed("NEXT_PUBLIC_SITE_URL");
check(
  "BLOCK",
  "NEXT_PUBLIC_SITE_URL 是 https 绝对地址",
  /^https:\/\//.test(siteUrl),
  !siteUrl
    ? "未设置（默认 http://localhost:3000）：生产分享页 OG 图与绝对链接会全指 localhost"
    : /^https:\/\//.test(siteUrl)
      ? siteUrl
      : `当前 ${siteUrl}（必须是 https:// 开头）`,
);

// 7. 登录体系（P0-1）：默认 none 的生产语义是「验证码固定 123456，任意手机号可登录」
const authProvider = trimmed("AUTH_PROVIDER") || "none";
const allowDevAuth = trimmed("ALLOW_DEV_AUTH") === "1";
check(
  "BLOCK",
  "AUTH_PROVIDER 不是 none（除非显式 ALLOW_DEV_AUTH=1）",
  authProvider !== "none" || allowDevAuth,
  authProvider !== "none"
    ? `当前 ${authProvider}`
    : allowDevAuth
      ? "ALLOW_DEV_AUTH=1 显式允许 dev provider：仅限预发/内部演示，不要对公网开"
      : "当前 none/未设置：固定验证码 123456 可登录任意手机号——配 sms/wechat，或显式 ALLOW_DEV_AUTH=1 承担风险",
);

// 8. session 签名密钥：默认值是源码里的公开常量，等于没签名（可伪造任意用户）
const secret = trimmed("SESSION_SECRET");
const sessionSecretOk = secret !== "" && secret !== "dev-only-insecure-secret";
check(
  "BLOCK",
  "SESSION_SECRET 不是开发默认值",
  sessionSecretOk,
  sessionSecretOk
    ? "已替换为随机密钥"
    : "用 openssl rand -hex 32 生成；默认值公开在源码里 = 任意用户 session 可伪造",
);

// 9. 指标看板（P0-8）：没有 token 时 /api/events/summary 一律 404，北极星不可见
const metricsTokenOk = Boolean(trimmed("METRICS_TOKEN"));
check(
  "WARN",
  "METRICS_TOKEN 已配置（指标看板可用）",
  metricsTokenOk,
  metricsTokenOk
    ? "看板可用"
    : "未配置 → /api/events/summary 一律 404：漏斗/北极星指标看不到（不影响主流程）",
);

check(
  "WARN",
  "COOKIE_SECURE 生产应为 1/unset（自动 https）",
  env("COOKIE_SECURE") !== "0",
  "COOKIE_SECURE=0 会让 session cookie 在 http 也发送",
);

// 10. 配额数字合法（未设置则用代码默认值 3 / 10，合法）
const DEFAULTS = { DAILY_FREE_LIMIT: 3, AUTH_USER_LIMIT: 10 };
for (const [name, min, max] of [
  ["DAILY_FREE_LIMIT", 1, 1000],
  ["AUTH_USER_LIMIT", 1, 1000],
]) {
  const raw = env(name);
  const v = raw === undefined || raw === "" ? DEFAULTS[name] : Number(raw);
  check(
    "BLOCK",
    `${name} 是 ${min}-${max} 的整数`,
    Number.isInteger(v) && v >= min && v <= max,
    raw === undefined || raw === "" ? `未设置 → 用默认 ${DEFAULTS[name]}` : `当前 ${raw}`,
  );
}

// 11. .env 不会被提交（密钥泄漏防线）
const gitignore = existsSync(".gitignore") ? readFileSync(".gitignore", "utf8") : "";
check("BLOCK", ".gitignore 包含 .env", gitignore.includes(".env"));

// 12. 构建产物存在（standalone）
check(
  "WARN",
  "已执行 npm run build",
  existsSync(".next/standalone/server.js"),
  "部署前必须构建；standalone 需 cp static 与 public（见 DEPLOY.md）",
);

// 13. Prisma Client 已生成（Prisma 7 起 @prisma/client 无 postinstall，
// npm ci 不会自动生成，缺 .prisma/client 时 postgres 路径一跑就崩）
check(
  "BLOCK",
  "Prisma Client 已生成",
  existsSync("node_modules/.prisma/client/default.js"),
  "跑 npx prisma generate（只读 schema，不连库）",
);

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
