#!/usr/bin/env node
/**
 * 端到端测试编排器（自包含，可本地跑也可在 CI 跑）：
 *   阶段 A（MOCK 高德）：桩 LLM + 测试服务器 3103 → 输入边界 9 例 + 故障注入 5 例
 *   阶段 B（真实模式）：桩 LLM + 高德桩 + 测试服务器 3104（带 AMAP key）
 *                       → 验真/坐标解析/通勤换算/未命中预警
 *   全部 tear down，退出码非零即失败
 *
 * 用法：npm test
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STUB_PORT = 8898;   // 桩 LLM
const AMAP_STUB_PORT = 8899; // 桩高德
const PORTS = { mock: 3103, real: 3104 };
const APP = (k) => `http://127.0.0.1:${PORTS[k]}`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name} ${detail}`);
    console.log(`  ❌ ${name} ${detail}`);
  }
}

const children = [];
function spawnCmd(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${cmd}] ${d}`));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[${cmd}] ${d}`));
  children.push(child);
  return child;
}

async function waitReady(url, timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 400) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function makeApi(base) {
  return {
    async post(payload) {
      const r = await fetch(`${base}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async postRaw(text) {
      const r = await fetch(`${base}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
    async waitJob(jobId, timeoutMs = 30000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const r = await fetch(`${base}/api/plan/status?id=${jobId}`);
        const d = await r.json();
        if (d.status === "done" || d.status === "error") return d;
        await new Promise((res) => setTimeout(res, 500));
      }
      return { status: "timeout" };
    },
  };
}

// ---------------- 阶段 A：MOCK 模式 ----------------

async function phaseA(api) {
  console.log("\n== 输入边界（应全部 400，不耗配额） ==");
  const cases = [
    ["空 body", {}],
    ["城市太短", { city: "北", days: 3, budget: 2500 }],
    ["天数=2", { city: "成都", days: 2, budget: 2500 }],
    ["天数=5（超上限）", { city: "成都", days: 5, budget: 2500 }],
    ["预算过低", { city: "成都", days: 3, budget: 100 }],
    ["预算=0", { city: "成都", days: 3, budget: 0 }],
    ["缺 budget", { city: "成都", days: 3 }],
    ["days 非数字", { city: "成都", days: "三", budget: 2500 }],
  ];
  for (const [name, payload] of cases) {
    const { status } = await api.post(payload);
    check(`${name} → 400`, status === 400, `got ${status}`);
  }
  const raw = await api.postRaw("{not json");
  check("畸形 JSON → 400", raw.status === 400, `got ${raw.status}`);

  console.log("\n== 故障注入 ==");

  console.log("-- 用例 1：正常链路（返回真实苏州 fixture）--");
  const r1 = await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] });
  check("POST 202", r1.status === 202, `got ${r1.status}`);
  const j1 = await api.waitJob(r1.body.jobId);
  check("任务 done", j1.status === "done", JSON.stringify(j1).slice(0, 120));
  const plan = j1.plan ?? {};
  check("3 天结构", plan.days?.length === 3);
  check("Day1 含真实 POI（拙政园/苏州博物馆）",
    (plan.days?.[0]?.spots ?? []).some((s) => s.name.includes("拙政园"))
    && (plan.days?.[0]?.spots ?? []).some((s) => s.name.includes("苏州博物馆")));
  check("预算预警触发（fixture 总价 1925 > 1000×1.05）",
    (plan.warnings ?? []).some((w) => w.includes("超出预算")),
    JSON.stringify(plan.warnings));
  check("节奏预警触发（Day1 7 点超 10 小时）",
    (plan.warnings ?? []).some((w) => w.includes("偏满")),
    JSON.stringify(plan.warnings));
  check("MOCK 模式 verified=false", plan.verified === false);
  check("remaining = 2", j1.remaining === 2, `got ${j1.remaining}`);

  console.log("-- 用例 2：垃圾输出 --");
  const j2 = await api.waitJob((await api.post({ city: "垃圾测试城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j2.status === "error");
  check("错误提示 JSON 不合法", (j2.error ?? "").includes("JSON"), j2.error);
  check("配额退还（remaining = 2）", j2.remaining === 2, `got ${j2.remaining}`);

  console.log("-- 用例 3：空 content --");
  const j3 = await api.waitJob((await api.post({ city: "空内容城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j3.status === "error");
  check("错误提示返回为空", (j3.error ?? "").includes("为空"), j3.error);
  check("配额退还（remaining = 2）", j3.remaining === 2, `got ${j3.remaining}`);

  console.log("-- 用例 4：上游 HTTP 500 --");
  const j4 = await api.waitJob((await api.post({ city: "错误500城市", days: 3, budget: 1000, preferences: [] })).body.jobId);
  check("任务 error", j4.status === "error");
  check("配额退还（remaining = 2）", j4.remaining === 2, `got ${j4.remaining}`);

  console.log("-- 用例 5：配额最终账目 --");
  const j5 = await api.waitJob((await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] })).body.jobId);
  check("再次生成成功", j5.status === "done");
  check("remaining = 1", j5.remaining === 1, `got ${j5.remaining}`);
}

// ---------------- 阶段 B：真实模式（高德桩） ----------------

async function phaseB(api) {
  console.log("\n== 高德集成（真实模式走桩，验证官方 API 形状） ==");
  const j = await api.waitJob(
    (await api.post({ city: "成都", days: 3, budget: 1000, preferences: ["美食"] })).body.jobId,
  );
  check("任务 done", j.status === "done", JSON.stringify(j).slice(0, 120));
  const plan = j.plan ?? {};
  const days = plan.days ?? [];

  check("verified=true（走了真实高德路径）", plan.verified === true);
  // fixture 每天点数 [7,5,4] → 段数 [6,4,3]；Day1 的「桃花源记」搜不到，
  // 涉及它的 2 段走 30 分钟 fallback，其余 4 段 22 分钟 → 4×22 + 2×30 = 148
  check("Day1 通勤 = 148 分钟（4 段×22 + 2 段 fallback×30）",
    days[0]?.transitMin === 148, `got ${days[0]?.transitMin}`);
  check("Day2 通勤 = 88 分钟（4 段）", days[1]?.transitMin === 88, `got ${days[1]?.transitMin}`);
  check("Day3 通勤 = 66 分钟（3 段）", days[2]?.transitMin === 66, `got ${days[2]?.transitMin}`);
  check("总价 = 1925（每日 cost 汇总正确）",
    plan.totalCostCny === 1925, `got ${plan.totalCostCny}`);
  check("POI 未命中预警（Day1 的桃花源记）",
    (plan.warnings ?? []).some((w) => w.includes("桃花源记") && w.includes("未在高德检索到")),
    JSON.stringify(plan.warnings));
  check("命中项不误报（拙政园不在未命中预警里）",
    !(plan.warnings ?? []).some((w) => w.includes("拙政园") && w.includes("未在高德")),
    JSON.stringify(plan.warnings));
}

// ---------------- 主流程 ----------------

async function main() {
  console.log("启动桩服务与两台测试服务器（MOCK 3103 / 真实 3104）……");
  spawnCmd("node", ["scripts/stub-llm.mjs", String(STUB_PORT)]);
  spawnCmd("node", ["scripts/amap-stub.mjs", String(AMAP_STUB_PORT)]);
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.mock)], {
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
  });
  spawnCmd("node", ["node_modules/next/dist/bin/next", "dev", "-p", String(PORTS.real)], {
    LLM_BASE_URL: `http://127.0.0.1:${STUB_PORT}/v1`,
    LLM_API_KEY: "stub-key",
    LLM_MODEL: "step-5-preview",
    AMAP_WEB_SERVICE_KEY: "stub-amap-key",
    AMAP_BASE_URL: `http://127.0.0.1:${AMAP_STUB_PORT}`,
  });

  const [upA, upB] = await Promise.all([
    waitReady(`${APP("mock")}/`),
    waitReady(`${APP("real")}/`),
  ]);
  if (!upA || !upB) {
    console.error(`❌ 测试服务器未就绪（mock=${upA}, real=${upB}）`);
    for (const c of children) c.kill("SIGTERM");
    process.exitCode = 1;
    return;
  }

  try {
    await phaseA(makeApi(APP("mock")));
    await phaseB(makeApi(APP("real")));
  } finally {
    for (const c of children) c.kill("SIGTERM");
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failures.length) {
    console.log("失败项：");
    for (const f of failures) console.log("  -", f);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
