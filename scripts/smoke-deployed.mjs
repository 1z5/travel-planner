#!/usr/bin/env node
/**
 * 部署后冒烟验收：对着已上线的域名跑一遍核心链路。
 *
 *   node scripts/smoke-deployed.mjs https://你的域名
 *
 * 依次验证：
 *   ① /api/health 配置自检（含部署 commit，可确认新版本真的上线）
 *   ② 首页可访问
 *   ③ **Trip Check 核验层**（v9 新形态，免配额、可重复）：
 *      /api/verify 元信息、/api/verify/schema、POST /api/verify 可复算凭据、
 *      /verify 体验台、robots 收录、CORS 预检
 *   ④ 提交一次真实规划并等结果（会消耗该服务器上你当前 IP 的 1 次当日配额）
 *   ⑤ 分享页凭据 + JSON-LD + shareId 核验（依赖 ④ 的产物）
 *
 * 任何一步失败给出可操作原因；全过输出 🟢 部署验收通过。
 *
 * 为什么要加 ③/⑤：产品形态已从「生成行程」升级为「可执行性核验层」，部署验收
 * 必须覆盖新形态（旧脚本只验生成链路，新功能挂了也会报绿）。③ 不烧配额，
 * 适合每次 push 后先跑；④ 才消耗配额。
 */
const BASE = (process.argv[2] ?? "").replace(/\/+$/, "");
if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.log("用法: node scripts/smoke-deployed.mjs https://你的域名");
  process.exit(1);
}

let failed = 0;
/** ④ 生成出来的分享 token，供 ⑤ 使用 */
let shareId = null;
const fail = (msg) => {
  failed += 1;
  console.log(`❌ ${msg}`);
};
const ok = (msg) => console.log(`✅ ${msg}`);

/** 带超时的 fetch（统一 15s，避免免费实例冷启动把整个脚本挂死） */
const get = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
const json = async (res) => res.json().catch(() => ({}));

// ① 健康检查
console.log(`目标: ${BASE}`);
let healthCommit = null;
try {
  const h = await json(await get("/api/health"));
  if (h.status !== "ok") {
    fail(`health 返回异常: ${JSON.stringify(h)}`);
  } else {
    healthCommit = typeof h.commit === "string" ? h.commit.slice(0, 7) : null;
    ok(
      `/api/health: llmConfigured=${h.llmConfigured} amapMode=${h.amapMode} auth=${h.authProvider}${
        healthCommit ? ` commit=${healthCommit}` : ""
      }`,
    );
    if (!h.llmConfigured) fail("LLM_API_KEY 未生效——检查部署环境变量注入");
    if (h.amapMode !== "live") console.log("⚠️  高德为 MOCK 模式（未配 AMAP key），POI 验真未生效");
  }
} catch (e) {
  fail(`/api/health 不可达: ${e?.message ?? e}（域名解析/安全组/服务是否起）`);
}

// ② 首页
try {
  const r = await get("/");
  const html = await r.text();
  if (r.status === 200 && html.includes("行程规划师")) {
    ok("首页可访问且渲染正常");
  } else {
    fail(`首页异常: HTTP ${r.status}`);
  }
} catch (e) {
  fail(`首页不可达: ${e?.message ?? e}`);
}

// ③ Trip Check 核验层（部署验收的一部分；不消耗生成配额）
console.log("\n— Trip Check 核验层 —");
try {
  const metaRes = await get("/api/verify");
  const meta = await json(metaRes);
  if (metaRes.status === 200 && meta.specVersion === "trip-check/0.1") {
    ok(
      `/api/verify: spec=${meta.specVersion} engine=${meta.engineVersion} rules=${meta.rulesetVersion}`,
    );
  } else {
    fail(`/api/verify 异常: HTTP ${metaRes.status} ${JSON.stringify(meta).slice(0, 120)}`);
  }

  const schemaRes = await get("/api/verify/schema");
  const schema = await json(schemaRes);
  if (schemaRes.status === 200 && schema.$defs?.spot) {
    ok("/api/verify/schema 可访问（JSON Schema 契约）");
  } else {
    fail(`/api/verify/schema 异常: HTTP ${schemaRes.status}`);
  }

  // 一份最小但完整核验的开放文档：结构干净 + 事实全 hit + 路段齐全 → A/verified
  const doc = {
    specVersion: "trip-check/0.1",
    id: "deploy_smoke",
    city: "苏州",
    budgetCny: 800,
    days: [
      {
        day: 1,
        date: "2026-11-03",
        spots: [
          {
            name: "拙政园",
            time: "09:00-11:00",
            type: "sight",
            durationMin: 120,
            costCny: 80,
            hours: { openTime: "周一至周日 07:30-17:30" },
            verification: { source: "amap", existence: "hit", hours: "hit" },
          },
          {
            name: "平江路",
            time: "11:30-13:00",
            type: "sight",
            durationMin: 90,
            costCny: 60,
            hours: { openTime: "24小时营业" },
            verification: { source: "amap", existence: "hit", hours: "hit" },
          },
        ],
        legs: [{ from: "拙政园", to: "平江路", mode: "walking", durationMin: 20 }],
      },
    ],
  };
  const postVerify = () =>
    get("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://example.com" },
      body: JSON.stringify({ document: doc }),
    });
  const verifyRes = await postVerify();
  const report = await json(verifyRes);
  const credentialId = report?.credential?.id;
  if (verifyRes.status === 200 && /^tc_[0-9a-f]{32}$/.test(credentialId ?? "")) {
    ok(
      `POST /api/verify: ${report.verdict?.consistency?.grade}/${report.verdict?.consistency?.score} · facts=${report.verdict?.facts?.state} · 凭据 ${credentialId.slice(0, 14)}…`,
    );
    if (verifyRes.headers.get("access-control-allow-origin") !== "*") {
      fail("POST /api/verify 缺少 CORS 响应头（第三方浏览器无法调用）");
    }
  } else {
    fail(`POST /api/verify 异常: HTTP ${verifyRes.status} ${JSON.stringify(report).slice(0, 120)}`);
  }

  // 可复算：同一文档再跑一次，凭据 ID 必须一致
  if (credentialId) {
    const again = await json(await postVerify());
    if (again?.credential?.id === credentialId) {
      ok("同一输入两次 → 同一凭据 ID（可复算）");
    } else {
      fail(`凭据不可复算: ${credentialId} vs ${again?.credential?.id}`);
    }
  }

  const pageRes = await get("/verify");
  const pageHtml = await pageRes.text();
  if (pageRes.status === 200 && pageHtml.includes("行程体检")) {
    ok("/verify 体验台可访问");
  } else {
    fail(`/verify 体验台异常: HTTP ${pageRes.status}`);
  }

  const robots = await (await get("/robots.txt")).text();
  if (robots.includes("/verify")) {
    ok("robots.txt 已允许 /verify（公开工具页可被索引）");
  } else {
    fail("robots.txt 未允许 /verify（搜索引擎无法发现体验台）");
  }
} catch (e) {
  fail(`Trip Check 验收异常: ${e?.message ?? e}`);
}

// ④ 提交一次真实规划
if (failed === 0) {
  console.log("\n— 生成链路 —");
  console.log("提交测试行程（成都 3 天，消耗当前 IP 1 次当日配额）…");
  try {
    // 日期必须带：/api/plan 用 startAt/endAt 推导天数与每日时间轴（缺了直接 400）。
    // 相对今天 +7 天，避免行程漂移到「进行中」影响后续断言。
    const ymd = (d) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const start = new Date(Date.now() + 7 * 86_400_000);
    const end = new Date(start.getTime() + 2 * 86_400_000);
    const r = await get("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        city: "成都",
        startAt: `${ymd(start)}T10:00`,
        endAt: `${ymd(end)}T18:00`,
        budget: 2000,
        preferences: ["美食"],
      }),
    });
    if (r.status === 429) {
      const b = await json(r);
      fail(`配额拦截: ${b.error ?? ""}（换网络或明天再验收）`);
    } else if (r.status !== 202) {
      const b = await json(r);
      fail(`提交失败 HTTP ${r.status}: ${b.error ?? ""}`);
    } else {
      const { jobId } = await r.json();
      const t0 = Date.now();
      let job = null;
      while (Date.now() - t0 < 10 * 60 * 1000) {
        await new Promise((res) => setTimeout(res, 5000));
        job = await json(await get(`/api/plan/status?id=${jobId}`));
        if (job.status === "done" || job.status === "error") break;
        process.stdout.write(".");
      }
      process.stdout.write("\n");
      if (job?.status === "done") {
        const p = job.plan;
        shareId = job.shareId ?? null;
        const spots = p.days.flatMap((d) => d.spots).length;
        ok(
          `生成成功: ${p.city} ${p.days.length} 天 / ${spots} 个点 / 总价 ¥${p.totalCostCny} / verified=${p.verified}`,
        );
        console.log(`   预警 ${p.warnings.length} 条，体检系统工作正常`);
      } else if (job?.status === "error") {
        fail(`生成失败: ${job.error}（查看服务端日志定位）`);
      } else {
        fail(
          "生成 10 分钟未完成（推理模型慢是正常的，但 10 分钟仍判超时——检查 LLM_BASE_URL 与模型名）",
        );
      }
    }
  } catch (e) {
    fail(`提交异常: ${e?.message ?? e}`);
  }
}

// ⑤ 分享页的体检凭据 + JSON-LD + shareId 核验（依赖 ④ 的产物）
if (failed === 0 && shareId) {
  console.log("\n— 分享页核验工件 —");
  try {
    const page = await get(`/p/${shareId}`);
    const html = await page.text();
    if (page.status === 200 && html.includes("行程体检凭据")) {
      ok("分享页展示体检凭据卡");
    } else {
      fail(`分享页缺少体检凭据卡: HTTP ${page.status}`);
    }
    if (html.includes("application/ld+json") && html.includes("TouristTrip")) {
      ok("分享页输出 schema.org TouristTrip JSON-LD");
    } else {
      fail("分享页缺少 schema.org JSON-LD");
    }
    const r = await get("/api/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shareId }),
    });
    const rep = await json(r);
    if (r.status === 200 && rep?.credential?.id) {
      ok(
        `shareId 核验: ${rep.verdict?.consistency?.grade} · facts=${rep.verdict?.facts?.state}（站内行程走同一引擎）`,
      );
    } else {
      fail(`shareId 核验异常: HTTP ${r.status} ${JSON.stringify(rep).slice(0, 120)}`);
    }
  } catch (e) {
    fail(`分享页核验异常: ${e?.message ?? e}`);
  }
}

console.log(failed === 0 ? "\n🟢 部署验收通过" : `\n🔴 验收未通过（${failed} 项）`);
if (healthCommit) console.log(`部署 commit: ${healthCommit}（应与本次 push 的 HEAD 一致）`);
process.exitCode = failed > 0 ? 1 : 0;
