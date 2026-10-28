#!/usr/bin/env node
/**
 * 演示预热脚本：演示前 2 分钟跑一次，把 Render 免费实例从休眠中叫醒并验证
 * 三条演示路径可用。免费实例 15 分钟无请求会休眠，首个请求要 30-60s 冷启动——
 * 别让第一位访客成为那个「等冷启动」的人。
 *
 * 用法：
 *   node scripts/warm-demo.mjs https://travel-planner-demo-xxxx.onrender.com
 *   DEMO_URL=https://... node scripts/warm-demo.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.argv[2] || process.env.DEMO_URL || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("用法：node scripts/warm-demo.mjs https://<你的-render-域名>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixtureShares() {
  const dir = path.join(ROOT, "demo", "fixtures");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .map((x) => ({ slug: x.slug, shareId: x.shareId }));
}

async function timedFetch(pathname, timeoutMs = 90_000) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: ctl.signal, redirect: "manual" });
    return { status: res.status, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`▶ 预热 ${BASE}（免费实例冷启动最长约 60s，请稍等）…`);

  // 1) 健康检查：冷启动 + 演示种子注入都发生在这段时间
  let health = null;
  for (let i = 0; i < 12; i += 1) {
    try {
      const r = await timedFetch("/api/health");
      if (r.status === 200) {
        health = r;
        break;
      }
      console.log(`  · /api/health → ${r.status}，继续等…`);
    } catch (e) {
      console.log(`  · 还没起来（${e instanceof Error ? e.name : String(e)}），继续等…`);
    }
    await sleep(5000);
  }
  if (!health) {
    console.error("❌ 10 分钟内没有预热成功，检查 Render 部署日志");
    process.exitCode = 1;
    return;
  }
  console.log(`✅ 实例已醒（健康检查 ${health.ms}ms）`);

  // 2) 静态页与演示种子
  for (const p of ["/", "/new", "/about"]) {
    const r = await timedFetch(p);
    console.log(`${r.status === 200 ? "✅" : "❌"} ${p} → ${r.status}（${r.ms}ms）`);
    if (r.status !== 200) process.exitCode = 1;
  }
  const shares = fixtureShares();
  for (const s of shares) {
    const r = await timedFetch(`/p/${s.shareId}`);
    console.log(`${r.status === 200 ? "✅" : "❌"} 演示行程 ${s.slug} → /p/${s.shareId}`);
    if (r.status !== 200) process.exitCode = 1;
  }
  if (!shares.length) console.log("⚠️ 本地没有 demo/fixtures/*.json（先生成演示行程）");

  // 3) 再打一次健康检查：确认冷启动后响应恢复稳定（演示时轮询接口要快）
  const again = await timedFetch("/api/health");
  console.log(`${again.status === 200 ? "✅" : "❌"} 二次健康检查 ${again.ms}ms`);
  if (!process.exitCode) console.log("\n🟢 预热完成，可以开始演示。");
}

main().catch((e) => {
  console.error(`❌ ${e.message}`);
  process.exitCode = 1;
});
