#!/usr/bin/env node
/**
 * 部署后冒烟验收：对着已上线的域名跑一遍核心链路。
 *
 *   node scripts/smoke-deployed.mjs https://你的域名
 *
 * 依次验证：① /api/health 配置自检 ② 首页可访问 ③ 提交一次真实规划并等结果
 * （注意：会消耗该服务器上你当前 IP 的 1 次当日配额）
 * 任何一步失败给出可操作原因；全过输出 🟢 部署验收通过。
 */
const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.log("用法: node scripts/smoke-deployed.mjs https://你的域名");
  process.exit(1);
}

let failed = 0;
const fail = (msg) => { failed += 1; console.log(`❌ ${msg}`); };

// ① 健康检查
console.log(`目标: ${BASE}`);
try {
  const h = await (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(15000) })).json();
  if (h.status !== "ok") {
    fail(`health 返回异常: ${JSON.stringify(h)}`);
  } else {
    console.log(`✅ /api/health: llmConfigured=${h.llmConfigured} amapMode=${h.amapMode} auth=${h.authProvider}`);
    if (!h.llmConfigured) fail("LLM_API_KEY 未生效——检查部署环境变量注入");
    if (h.amapMode !== "live") console.log("⚠️  高德为 MOCK 模式（未配 AMAP key），POI 验真未生效");
  }
} catch (e) {
  fail(`/api/health 不可达: ${e?.message ?? e}（域名解析/安全组/服务是否起）`);
}

// ② 首页
try {
  const r = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(15000) });
  const html = await r.text();
  if (r.status === 200 && html.includes("行程规划师")) {
    console.log("✅ 首页可访问且渲染正常");
  } else {
    fail(`首页异常: HTTP ${r.status}`);
  }
} catch (e) {
  fail(`首页不可达: ${e?.message ?? e}`);
}

// ③ 提交一次真实规划
if (failed === 0) {
  console.log("提交测试行程（成都 3 天，消耗当前 IP 1 次当日配额）…");
  try {
    const r = await fetch(`${BASE}/api/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ city: "成都", days: 3, budget: 2000, preferences: ["美食"] }),
      signal: AbortSignal.timeout(30000),
    });
    if (r.status === 429) {
      const b = await r.json().catch(() => ({}));
      fail(`配额拦截: ${b.error ?? ""}（换网络或明天再验收）`);
    } else if (r.status !== 202) {
      const b = await r.json().catch(() => ({}));
      fail(`提交失败 HTTP ${r.status}: ${b.error ?? ""}`);
    } else {
      const { jobId } = await r.json();
      const t0 = Date.now();
      let job = null;
      while (Date.now() - t0 < 10 * 60 * 1000) {
        await new Promise((res) => setTimeout(res, 5000));
        job = await (await fetch(`${BASE}/api/plan/status?id=${jobId}`)).json();
        if (job.status === "done" || job.status === "error") break;
        process.stdout.write(".");
      }
      process.stdout.write("\n");
      if (job?.status === "done") {
        const p = job.plan;
        const spots = p.days.flatMap((d) => d.spots).length;
        console.log(`✅ 生成成功: ${p.city} ${p.days.length} 天 / ${spots} 个点 / 总价 ¥${p.totalCostCny} / verified=${p.verified}`);
        console.log(`   预警 ${p.warnings.length} 条，体检系统工作正常`);
      } else if (job?.status === "error") {
        fail(`生成失败: ${job.error}（查看服务端日志定位）`);
      } else {
        fail("生成 10 分钟未完成（推理模型慢是正常的，但 10 分钟仍判超时——检查 LLM_BASE_URL 与模型名）");
      }
    }
  } catch (e) {
    fail(`提交异常: ${e?.message ?? e}`);
  }
}

console.log(failed === 0 ? "\n🟢 部署验收通过" : `\n🔴 验收未通过（${failed} 项）`);
process.exitCode = failed > 0 ? 1 : 0;
