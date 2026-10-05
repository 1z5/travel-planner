#!/usr/bin/env node
/**
 * M2 系统评测：一批真实 case 跑「生成 + 高德验真」，出量化报告。
 *
 *   # 前置 1：起服务（真实高德 key 已在 .env；评测量大，临时放大配额）
 *   DAILY_FREE_LIMIT=200 npm run dev
 *   # 前置 2：跑评测（默认 20 case，并发 3）
 *   npm run eval:cases
 *
 * 指标：成功率 / POI 验真率 / 通勤预警率 / 预算贴合度 / 平均耗时。
 * 结果存 eval-results/<时间戳>.json。
 */
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.EVAL_BASE || "http://127.0.0.1:3000";
const CASES_TOTAL = Number(process.env.EVAL_CASES || 20);
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY || 3);
const TIMEOUT_MS = 10 * 60 * 1000; // 单 case 上限 10 分钟

// 20 个覆盖不同城市/天数/预算/偏好的 case
const CASES = [
  { city: "北京", days: 4, budget: 4000, preferences: ["历史文化", "美食"] },
  { city: "上海", days: 3, budget: 3500, preferences: ["Citywalk", "拍照打卡"] },
  { city: "广州", days: 3, budget: 2800, preferences: ["美食"] },
  { city: "深圳", days: 3, budget: 3000, preferences: ["购物", "夜生活"] },
  { city: "成都", days: 4, budget: 3000, preferences: ["美食", "历史文化"] },
  { city: "杭州", days: 3, budget: 2800, preferences: ["自然风光", "美食"] },
  { city: "西安", days: 4, budget: 2500, preferences: ["历史文化"] },
  { city: "重庆", days: 4, budget: 3200, preferences: ["美食", "拍照打卡"] },
  { city: "厦门", days: 3, budget: 3000, preferences: ["自然风光", "小众冷门"] },
  { city: "苏州", days: 3, budget: 2500, preferences: ["历史文化", "Citywalk"] },
  { city: "南京", days: 3, budget: 2600, preferences: ["历史文化", "美食"] },
  { city: "长沙", days: 3, budget: 2200, preferences: ["美食", "夜生活"] },
  { city: "青岛", days: 3, budget: 2800, preferences: ["自然风光", "拍照打卡"] },
  { city: "昆明", days: 4, budget: 3000, preferences: ["自然风光", "小众冷门"] },
  { city: "大理", days: 4, budget: 3500, preferences: ["自然风光", "小众冷门"] },
  { city: "天津", days: 3, budget: 2400, preferences: ["历史文化", "美食"] },
  { city: "武汉", days: 3, budget: 2500, preferences: ["历史文化", "美食"] },
  { city: "洛阳", days: 3, budget: 2200, preferences: ["历史文化", "小众冷门"] },
  { city: "泉州", days: 3, budget: 2400, preferences: ["历史文化", "小众冷门"] },
  { city: "哈尔滨", days: 4, budget: 3800, preferences: ["自然风光", "美食"] },
].slice(0, CASES_TOTAL);

async function runCase(c, index) {
  const t0 = Date.now();
  const tag = `[${index + 1}/${CASES.length}] ${c.city}`;
  try {
    const r = await fetch(`${BASE}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(c),
    });
    if (r.status !== 202) {
      const body = await r.json().catch(() => ({}));
      console.log(`${tag} ❌ 提交被拒 HTTP ${r.status}: ${body.error ?? ""}`);
      return { case: c, success: false, httpStatus: r.status, error: body.error };
    }
    const { jobId } = await r.json();

    // 轮询
    let job = null;
    while (Date.now() - t0 < TIMEOUT_MS) {
      await new Promise((res) => setTimeout(res, 5000));
      job = await (await fetch(`${BASE}/api/plan/status?id=${jobId}`)).json();
      if (job.status === "done" || job.status === "error") break;
    }
    if (!job || (job.status !== "done" && job.status !== "error")) {
      console.log(`${tag} ❌ 超时（10 分钟）`);
      return { case: c, success: false, error: "timeout", durationSec: Math.round((Date.now() - t0) / 1000) };
    }
    if (job.status === "error") {
      console.log(`${tag} ❌ 生成失败: ${job.error}`);
      return { case: c, success: false, error: job.error, durationSec: Math.round((Date.now() - t0) / 1000) };
    }

    const p = job.plan;
    const spots = p.days.flatMap((d) => d.spots);
    const poisChecked = spots.filter((s) => s.type === "sight" || s.type === "food").length;
    const misses = (p.warnings ?? []).filter((w) => w.includes("未在高德")).length;
    const transitWarn = (p.warnings ?? []).filter((w) => w.includes("通勤")).length;
    const rhythmWarn = (p.warnings ?? []).filter((w) => w.includes("偏满") || w.includes("偏松")).length;
    const budgetWarn = (p.warnings ?? []).some((w) => w.includes("超出预算"));
    const durationSec = Math.round((Date.now() - t0) / 1000);

    console.log(
      `${tag} ✅ ${durationSec}s | 验真 ${poisChecked - misses}/${poisChecked}` +
      ` | 预算 ${Math.round((p.totalCostCny / c.budget) * 100)}%` +
      ` | 预警 ${p.warnings.length}（通勤${transitWarn}/节奏${rhythmWarn}/预算${budgetWarn ? 1 : 0}）`,
    );
    return {
      case: c, success: true, durationSec,
      verified: p.verified, poisChecked, misses, transitWarn, rhythmWarn, budgetWarn,
      totalCostCny: p.totalCostCny, warnings: p.warnings.length,
    };
  } catch (e) {
    console.log(`${tag} ❌ 异常: ${e?.message ?? e}`);
    return { case: c, success: false, error: String(e?.message ?? e) };
  }
}

// 并发池
async function runAll() {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < CASES.length) {
      const i = cursor++;
      results[i] = await runCase(CASES[i], i);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

const results = await runAll();

// ---- 汇总 ----
const ok = results.filter((r) => r.success);
const withVerified = ok.filter((r) => r.verified);
const poisTotal = ok.reduce((s, r) => s + r.poisChecked, 0);
const missesTotal = ok.reduce((s, r) => s + r.misses, 0);
const durations = ok.map((r) => r.durationSec).sort((a, b) => a - b);
const median = (arr) => (arr.length ? arr[Math.floor(arr.length / 2)] : 0);
const budgetRatios = ok.map((r) => Math.round((r.totalCostCny / r.case.budget) * 100)).sort((a, b) => a - b);

console.log("\n================ 评测报告 ================");
console.log(`成功率:        ${ok.length}/${results.length}`);
console.log(`验真模式覆盖:  ${withVerified.length}/${ok.length}（verified=true 的 case）`);
console.log(`POI 验真率:    ${poisTotal ? Math.round(((poisTotal - missesTotal) / poisTotal) * 1000) / 10 : "-"}%（${poisTotal - missesTotal}/${poisTotal}）`);
console.log(`通勤预警率:    ${ok.length ? Math.round((ok.filter((r) => r.transitWarn > 0).length / ok.length) * 100) : 0}% 的行程被标记疑似绕路`);
console.log(`预算贴合度:    中位 ${median(budgetRatios)}%（预算的百分之多少被用掉；>105% 为超支）`);
console.log(`耗时:          中位 ${median(durations)}s，最快 ${durations[0] ?? "-"}s，最慢 ${durations[durations.length - 1] ?? "-"}s`);
console.log(`超支 case:      ${ok.filter((r) => r.budgetWarn).length} 个`);

const outDir = "eval-results";
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
writeFileSync(`${outDir}/${stamp}.json`, JSON.stringify({ summary: { total: results.length, ok: ok.length }, results }, null, 2));
console.log(`\n明细已存 ${outDir}/${stamp}.json`);
