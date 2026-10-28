#!/usr/bin/env node
/**
 * 演示用例生成器：用**真实高德 + 真实 LLM** 生成 2-3 条行程，落成 demo/fixtures/*.json。
 *
 * 为什么需要：演示最怕「现场等 3 分钟出结果」。把几条真实生成的行程预先落成
 * fixture，服务启动时（DEMO_SEED=1）直接灌进存储 → 演示页/share/工作台/报告全部秒开，
 * 而且链接在重启/冷启动后依然有效（fixture 存在仓库里，不靠进程内存）。
 *
 * 成本：每条 3-4 天行程约 1.5-3 万 tokens（见 DEPLOY.md 成本模型），一次性。
 * 产物：demo/fixtures/<slug>.json + 自动重写 demo/fixtures/index.ts（勿手改 index）。
 *
 * 用法：
 *   node scripts/demo-gen.mjs                 # 自起隔离 dev server（.next-demo，真实 env）
 *   DEMO_BASE=http://127.0.0.1:3000 node scripts/demo-gen.mjs   # 用已在跑的服务
 *   DEMO_CASES=suzhou-3d,chengdu-4d node scripts/demo-gen.mjs    # 只生成指定 case
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "demo", "fixtures");
const TIMEOUT_MS = 12 * 60_000;

// 演示用 case：少而精——覆盖「短途城市」「多天美食+历史」两种典型形态。
// 日期按生成时刻 +14 天算（见 dateRangeFor），保证演示时是「未来行程」。
const ALL_CASES = [
  {
    slug: "suzhou-3d",
    label: "苏州 · 3 天（园林 + Citywalk）",
    city: "苏州",
    days: 3,
    budget: 2500,
    preferences: ["历史文化", "Citywalk"],
  },
  {
    slug: "chengdu-4d",
    label: "成都 · 4 天（美食 + 历史文化）",
    city: "成都",
    days: 4,
    budget: 3000,
    preferences: ["美食", "历史文化"],
  },
];

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 起止时间：+14 天出发，含头含尾 days 天（API 由起止日期推导天数） */
function dateRangeFor(days) {
  const start = new Date(Date.now() + 14 * 86_400_000);
  const end = new Date(start.getTime() + (days - 1) * 86_400_000);
  return { startAt: `${fmtDate(start)}T10:00`, endAt: `${fmtDate(end)}T18:00` };
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function pickPort(start) {
  for (let p = start; p < start + 50; p += 1) if (await portFree(p)) return p;
  throw new Error(`从 ${start} 起找不到空闲端口`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 400) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return false;
}

async function generateOne(baseUrl, c) {
  const range = dateRangeFor(c.days);
  const payload = {
    city: c.city,
    startAt: range.startAt,
    endAt: range.endAt,
    budget: c.budget,
    preferences: c.preferences,
  };
  console.log(`\n▶ 生成 ${c.slug}（${c.city} ${c.days} 天）…`);
  const t0 = Date.now();
  const res = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 202 || !body.jobId) {
    throw new Error(`${c.slug} 提交失败：HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  let lastStage = "";
  while (Date.now() < deadline) {
    const d = await (await fetch(`${baseUrl}/api/plan/status?id=${body.jobId}`)).json();
    if (d.stage && d.stage !== lastStage) {
      lastStage = d.stage;
      console.log(`  · ${c.slug} 阶段：${d.stage}`);
    }
    if (d.status === "done") {
      if (!d.shareId) throw new Error(`${c.slug} 完成但没有 shareId（持久化失败）`);
      const fixture = {
        slug: c.slug,
        label: c.label,
        shareId: d.shareId,
        input: payload,
        plan: d.plan,
        generatedAt: new Date().toISOString(),
        verification: d.plan?.verification,
        warnings: d.plan?.warnings?.length ?? 0,
      };
      fs.writeFileSync(
        path.join(FIXTURE_DIR, `${c.slug}.json`),
        `${JSON.stringify(fixture, null, 2)}\n`,
      );
      console.log(
        `✅ ${c.slug} 完成：shareId=${d.shareId} 用时 ${((Date.now() - t0) / 1000).toFixed(0)}s 预警 ${fixture.warnings} 条`,
      );
      return fixture;
    }
    if (d.status === "error") throw new Error(`${c.slug} 生成失败：${d.error}`);
    await sleep(2000);
  }
  throw new Error(`${c.slug} 超时（${TIMEOUT_MS / 60000} 分钟）`);
}

/** 用生成的 fixture 重写 index.ts（静态 import 才能被打进 standalone 产物） */
function writeIndex(fixtures) {
  const importLines = fixtures.map((f, i) => `import case${i} from "./${f.slug}.json";`).join("\n");
  const items = fixtures.map((f, i) => `  case${i} as unknown as DemoFixture,`).join("\n");
  const content = `// ⚠️ 本文件由 scripts/demo-gen.mjs 自动生成，请勿手改。
// 为什么用静态 import 而不是 fs.readdir：Next standalone 的产物只包含被静态
// import 追踪到的文件——fixture 要随镜像/部署产物一起走，必须静态引用。
import type { Plan, PlanInput } from "@/lib/types";

${importLines}

/** 一条演示行程（真实生成产物：真实 POI/营业时间/通勤） */
export interface DemoFixture {
  /** 稳定的分享 token：重启/冷启动后同一个链接依然有效（fixture 在仓库里） */
  shareId: string;
  /** 生成时的原始输入：克隆/继续编辑/分享页展示都要 */
  input: PlanInput;
  plan: Plan;
  generatedAt: string;
  label: string;
}

export const DEMO_FIXTURES: DemoFixture[] = [
${items}
];
`;
  fs.writeFileSync(path.join(FIXTURE_DIR, "index.ts"), content);
}

async function main() {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const only = (process.env.DEMO_CASES ?? "").trim();
  const cases = only ? ALL_CASES.filter((c) => only.split(",").includes(c.slug)) : ALL_CASES;
  if (!cases.length) throw new Error(`DEMO_CASES 没有匹配的 case：${only}`);

  let baseUrl = process.env.DEMO_BASE || null;
  let server = null;
  // tsconfig 会被 next dev 改写：跑完还原，别把本地产物路径带进提交（审计 P1-4）
  const tsconfigPath = path.join(ROOT, "tsconfig.json");
  const tsconfigSnapshot = fs.existsSync(tsconfigPath)
    ? fs.readFileSync(tsconfigPath, "utf8")
    : null;

  try {
    if (!baseUrl) {
      const port = await pickPort(3010);
      console.log(`▶ 启动隔离 dev server :${port}（dist=.next-demo，加载仓库 .env 的真实 key）…`);
      server = spawn(
        process.execPath,
        ["node_modules/next/dist/bin/next", "dev", "-p", String(port)],
        {
          cwd: ROOT,
          env: { ...process.env, NEXT_DIST_DIR: ".next-demo" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[next] ${d}`));
      server.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[next] ${d}`));
      baseUrl = `http://127.0.0.1:${port}`;
      if (!(await waitHttp(baseUrl))) throw new Error("dev server 未就绪");
      console.log("▶ 服务就绪");
    }

    const generated = [];
    for (const c of cases) generated.push(await generateOne(baseUrl, c));

    // 已存在的其它 fixture 也要保留在 index 里（只生成部分 case 时不丢旧的）
    const fixtureFiles = fs
      .readdirSync(FIXTURE_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const all = fixtureFiles.map((f) =>
      JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), "utf8")),
    );
    writeIndex(all);
    console.log(`\n✅ 已生成 ${generated.length} 条；index 共 ${all.length} 条 fixture。`);
    console.log("   下一步：DEMO_SEED=1 启动服务，share 链接即可直接打开。");
  } finally {
    if (server) server.kill("SIGTERM");
    if (tsconfigSnapshot !== null) {
      try {
        if (fs.readFileSync(tsconfigPath, "utf8") !== tsconfigSnapshot) {
          fs.writeFileSync(tsconfigPath, tsconfigSnapshot);
          console.log("↩︎ 已还原 tsconfig.json（next dev 运行时会改写）");
        }
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`);
  process.exitCode = 1;
});
