#!/usr/bin/env node
/** 用现有生成 API 比较首次可用快照与最终计划。运行方式见 docs/GENERATION-EVAL.md。 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { build } from "vite";

const BASE = process.env.EVAL_BASE || "http://127.0.0.1:3000";
const CASES_TOTAL = positiveInt("EVAL_CASES", 20);
const CONCURRENCY = positiveInt("EVAL_CONCURRENCY", 3);
const POLL_MS = positiveInt("EVAL_POLL_MS", 1000);
const TIMEOUT_MS = positiveInt("EVAL_TIMEOUT_MS", 600_000);
const SOURCE = process.env.EVAL_SOURCE || "unspecified";
const SUITE = process.env.EVAL_SUITE || "regional";
const SERVER_LOG = process.env.EVAL_SERVER_LOG;
if (!["comparison", "regional"].includes(SUITE)) throw new Error("无效的 EVAL_SUITE");
if (SERVER_LOG && CONCURRENCY !== 1)
  throw new Error("采集独占服务日志时，EVAL_CONCURRENCY 必须为 1");

function positiveInt(key, fallback) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} 必须为正整数`);
  return value;
}

// 20 个覆盖不同城市/天数/预算/偏好的 case
const REGIONAL_CASES = [
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
];

const COMPARISON_CASES = [
  { city: "苏州", days: 3, budget: 2500, preferences: ["历史文化", "Citywalk"] },
  { city: "苏州", days: 5, budget: 4500, preferences: ["历史文化", "Citywalk"] },
  { city: "苏州", days: 3, budget: 650, preferences: ["小众冷门"] },
];
const CASES = (SUITE === "comparison" ? COMPARISON_CASES : REGIONAL_CASES).slice(0, CASES_TOTAL);

// 统一记录实际提交的输入，复盘能区分日期/预算差异与算法变化。
const start = new Date(Date.now() + 86400000);
function dateRangeFor(days) {
  const fmt = (d, hhmm) => {
    const y = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${mo}-${da}T${hhmm}`;
  };
  const end = new Date(start);
  end.setDate(start.getDate() + days - 1);
  return { startAt: fmt(start, "10:00"), endAt: fmt(end, "18:00") };
}

// 复用 Trip Check 的规则，评测口径跟产品报告同步。
async function loadMetrics() {
  const outDir = mkdtempSync(join(tmpdir(), "travel-eval-"));
  try {
    await build({
      configFile: false,
      logLevel: "error",
      build: {
        ssr: fileURLToPath(new URL("./lib/eval-plan.ts", import.meta.url)),
        outDir,
        target: "node22",
        rollupOptions: { output: { entryFileNames: "eval-plan.mjs" } },
      },
    });
    return (await import(pathToFileURL(join(outDir, "eval-plan.mjs")).href)).measurePlan;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function loggedUsage(offset) {
  if (offset === null) return null;
  const log = readFileSync(SERVER_LOG).subarray(offset).toString("utf8");
  const samples = [...log.matchAll(/\[llm\][^\r\n]*? tokens=(\d+|\?)(?=\s|$)/g)];
  const counts = samples.flatMap(([, value]) => (value === "?" ? [] : [Number(value)]));
  return {
    callsWithUsage: counts.length,
    callsWithoutUsage: samples.length - counts.length,
    reportedTokens: counts.length ? counts.reduce((sum, value) => sum + value, 0) : null,
  };
}

function usable(plan) {
  return (
    plan?.days?.some((day) => day.spots?.length > 0) && (!plan.draft || plan.draftKind === "fast")
  );
}

const measurePlan = await loadMetrics();

async function runCase(c, index) {
  const t0 = performance.now();
  const observedMs = () => Math.round(performance.now() - t0);
  const tag = `[${index + 1}/${CASES.length}] ${c.city} ${c.days} 天 ${c.budget} 元`;
  const { days, ...rest } = c;
  const input = { ...rest, ...dateRangeFor(days) };
  const logOffset = SERVER_LOG ? readFileSync(SERVER_LOG).length : null;
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let first = null;
  let final = null;
  let statusCode;
  let error;

  const snapshot = (plan, kind) => ({
    observedMs: observedMs(),
    kind,
    metrics: measurePlan(plan, days, input),
    usage: loggedUsage(logOffset),
  });

  try {
    const r = await fetch(`${BASE}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    const accepted = await r.json();
    if (r.status !== 202 || !accepted.jobId) {
      statusCode = r.status;
      throw new Error(accepted.error || "未收到生成任务 ID");
    }

    const jobUrl = `${BASE}/api/plan/status?id=${encodeURIComponent(accepted.jobId)}`;
    for (;;) {
      const response = await fetch(jobUrl, { signal });
      const job = await response.json();
      if (!response.ok || job.status === "error") {
        statusCode = response.status;
        throw new Error(job.error || "状态查询失败");
      }
      if (job.status === "done") {
        if (!usable(job.plan)) throw new Error("生成结束但没有可用计划");
        final = snapshot(job.plan, "final");
        first ??= final;
        break;
      }
      if (job.status !== "running") throw new Error("未知的生成状态");
      if (!first && usable(job.plan)) {
        first = snapshot(job.plan, job.plan.draftKind === "fast" ? "fast" : "partial");
      }
      await delay(POLL_MS, undefined, { signal });
    }
  } catch (e) {
    error = signal.aborted ? "timeout" : String(e?.message ?? e);
  }
  const elapsedMs = observedMs();
  if (final) {
    const m = final.metrics;
    console.log(
      `${tag} ✅ 首份 ${first.observedMs}ms（${first.kind}）/ 最终 ${final.observedMs}ms · 地点命中 ${m.coverage.poiHit}/${m.coverage.poiTotal} · 结构 ${m.consistencyScore}`,
    );
  } else {
    console.log(`${tag} ❌ ${error}`);
  }
  return { case: c, input, success: !!final, elapsedMs, statusCode, error, first, final };
}

const results = [];
let cursor = 0;
async function worker() {
  while (cursor < CASES.length) {
    const i = cursor++;
    results[i] = await runCase(CASES[i], i);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, CASES.length) }, worker));

// 汇总使用最早有站点的快照，保留最终失败前已出现的初版。
const successful = results.filter((result) => result.success);
const summary = {
  total: results.length,
  ok: successful.length,
  beforeFinal: successful.filter(({ first }) => first.kind !== "final").length,
  firstComplete: results.filter(({ first }) => first?.metrics.complete).length,
  finalComplete: successful.filter(({ final }) => final.metrics.complete).length,
};
console.log(
  `\n成功 ${summary.ok}/${summary.total}，${summary.beforeFinal} 个成功任务观察到提前可用计划。首份覆盖全部天数 ${summary.firstComplete}/${summary.total}，终稿 ${summary.finalComplete}/${summary.total}。`,
);

const outDir = "eval-results";
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const filename = `${outDir}/generation-${stamp}.json`;
writeFileSync(
  filename,
  JSON.stringify(
    {
      suite: SUITE,
      source: SOURCE,
      pollMs: POLL_MS,
      concurrency: CONCURRENCY,
      summary,
      results,
    },
    null,
    2,
  ),
);
console.log(`明细已存 ${filename}`);
if (summary.ok !== summary.total) process.exitCode = 1;
