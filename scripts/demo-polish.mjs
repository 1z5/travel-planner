#!/usr/bin/env node
/**
 * 演示行程打磨：对 demo/fixtures 里的行程跑产品自己的「一键顺延」
 * （POST /api/plan/adjust op=retime，确定性重排，不调模型、不烧 token）。
 *
 * 为什么需要：真实生成的行程常有「时间接不上」预警（模型不按真实路段排时间），
 * 分享页首屏的可执行性评分会偏低。面试/演示链接的第一印象不该是「D 待优化」。
 * 打磨后：预警更少、评分更高，同时证明「一键顺延」在真实数据上确实有效。
 *
 * 用法：
 *   node scripts/demo-polish.mjs                      # 默认打磨 chengdu-4d
 *   DEMO_POLISH=suzhou-3d,chengdu-4d node scripts/demo-polish.mjs
 *   DEMO_BASE=http://127.0.0.1:3000 node scripts/demo-polish.mjs   # 用已在跑的服务
 *
 * 产物：更新对应 fixture JSON 的 plan（revision/顺延说明写在 polish 字段），
 * index.ts 不需要重生成（静态 import 的是文件名）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = path.join(ROOT, "demo", "fixtures");
const DEFAULT_TARGETS = "chengdu-4d";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function adjustDay(baseUrl, shareId, day) {
  const res = await fetch(`${baseUrl}/api/plan/adjust`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shareId, day, op: "retime" }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  const targets = (process.env.DEMO_POLISH ?? DEFAULT_TARGETS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let baseUrl = process.env.DEMO_BASE || null;
  let server = null;
  // next dev 会改写 tracked 的 tsconfig.json：跑完还原（与 demo-gen 同口径）
  const tsconfigPath = path.join(ROOT, "tsconfig.json");
  const tsconfigSnapshot = fs.existsSync(tsconfigPath)
    ? fs.readFileSync(tsconfigPath, "utf8")
    : null;

  try {
    if (!baseUrl) {
      const port = await pickPort(3010);
      console.log(`▶ 启动隔离 dev server :${port}（DEMO_SEED=1 注入 fixture）…`);
      server = spawn(
        process.execPath,
        ["node_modules/next/dist/bin/next", "dev", "-p", String(port)],
        {
          cwd: ROOT,
          env: { ...process.env, NEXT_DIST_DIR: ".next-demo", DEMO_SEED: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      server.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[next] ${d}`));
      server.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[next] ${d}`));
      baseUrl = `http://127.0.0.1:${port}`;
      if (!(await waitHttp(baseUrl))) throw new Error("dev server 未就绪");
      console.log("▶ 服务就绪");
    }

    for (const slug of targets) {
      const file = path.join(FIXTURE_DIR, `${slug}.json`);
      if (!fs.existsSync(file)) {
        console.warn(`⚠️ 跳过 ${slug}：fixture 不存在`);
        continue;
      }
      const fixture = JSON.parse(fs.readFileSync(file, "utf8"));
      const before = fixture.plan.warnings ?? [];
      console.log(
        `\n▶ 打磨 ${slug}（${fixture.plan.city} ${fixture.plan.days.length} 天）当前 ${before.length} 条预警`,
      );

      let plan = fixture.plan;
      const adjusted = [];
      for (const day of plan.days) {
        const r = await adjustDay(baseUrl, fixture.shareId, day.day);
        if (r.status === 200 && r.body?.plan) {
          plan = r.body.plan;
          adjusted.push({ day: day.day, notes: r.body.notes ?? [] });
          console.log(
            `  · 第 ${day.day} 天已顺延（${(r.body.notes ?? []).join("；") || "无需改动"}）`,
          );
        } else {
          console.log(`  · 第 ${day.day} 天跳过：HTTP ${r.status} ${r.body?.error ?? ""}`);
        }
      }

      const after = plan.warnings ?? [];
      const polishedAt = new Date().toISOString();
      // 只在真的变好时落盘：打磨失败/无变化不写文件（保留原始 fixture）
      if (after.length < before.length && adjusted.length > 0) {
        fixture.plan = plan;
        // 核验时间戳：POI 事实是生成时核验的，顺延不重新核验，用生成时间作为证据时间
        fixture.plan.verifiedAt = Date.parse(fixture.generatedAt);
        fixture.polishedAt = polishedAt;
        fixture.polish = {
          op: "retime",
          daysAdjusted: adjusted.map((a) => a.day),
          warningsBefore: before.length,
          warningsAfter: after.length,
        };
        fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
        console.log(`✅ ${slug}：预警 ${before.length} → ${after.length}，已写回 fixture`);
      } else {
        console.log(`↩︎ ${slug}：预警未减少（${before.length} → ${after.length}），保留原文件`);
      }
    }
    console.log("\n完成。别忘了 git add demo/fixtures && commit（Render 会自动重新部署）。");
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
