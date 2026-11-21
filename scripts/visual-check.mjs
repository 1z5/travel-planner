#!/usr/bin/env node
/**
 * 视觉 / 可访问性回归检查（零依赖，仓库内可复现）
 *
 * 为什么需要它：这个项目的 UI 大量由 AI 代理修改，「这次改完好不好看」不能
 * 只靠人眼和一次性截图脚本。这个脚本把 QA 报告里的口径固化成可执行检查：
 *   1. 横向溢出（scrollWidth > clientWidth）
 *   2. 触控目标（button/summary/受控链接 < 40px 高）
 *   3. 文本对比度（关键选择器 < 4.5:1，大字号 < 3:1）
 *   4. 控制台异常 / 未捕获异常
 *   5. 关键页面元素存在性（防止整块被删）
 * 同时输出全页截图与 JSON 报告到 eval-results/visual/（已 gitignore）。
 *
 * 用法：
 *   npm run gate:visual                  # 自起桩 LLM + dev server + 种子数据
 *   npm run gate:visual -- --base-url http://127.0.0.1:3001   # 复用已跑的服务器
 *   npm run gate:visual -- --share <token>                    # 复用已有分享 token
 *
 * 依赖本机 Chrome（可用 CHROME_PATH 覆盖路径）。CI 默认不跑它（无 GUI Chrome），
 * 本地与「提交前的视觉验收」用它。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCdp, openCdp } from "./lib/chrome-cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
}
const BASE_URL = opt("base-url");
const SHARE_ARG = opt("share");
const darkTheme = opt("theme") === "dark";
const OUT_DIR = path.join(ROOT, "eval-results", "visual", ...(darkTheme ? ["dark"] : []));
const CHROME =
  process.env.CHROME_PATH ||
  [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const failures = [];
const warnings = [];
function fail(msg) {
  failures.push(msg);
  log(`  ❌ ${msg}`);
}
function warn(msg) {
  warnings.push(msg);
  log(`  ⚠️  ${msg}`);
}

// ---------- 进程与端口 ----------
const children = [];
function spawnCmd(cmd, argv, env = {}) {
  const child = spawn(cmd, argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.env.VERBOSE && process.stdout.write(`[${cmd}] ${d}`));
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(`[${cmd}] ${d}`));
  children.push(child);
  return child;
}
function teardown() {
  for (const c of children) {
    try {
      c.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
}

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}
async function pickPort(start) {
  for (let p = start; p < start + 200; p += 1) if (await portFree(p)) return p;
  throw new Error(`从 ${start} 起找不到空闲端口`);
}
async function waitHttp(url, timeoutMs = 180_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 404) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  return false;
}

// ---------- 页面检查脚本（在浏览器里执行） ----------
const PAGE_CHECK_FN = String.raw`
(() => {
  const doc = document.documentElement;
  const out = {
    overflow: { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth },
    smallTargets: [],
    contrast: [],
    unnamedControls: [],
    platform: {},
  };

  // ---- 触控目标：只查「控件类」元素，行内文本链接豁免（WCAG 2.5.8 允许） ----
  const CONTROL_SELECTOR = [
    'button',
    'summary',
    '[role="button"]',
    'a.poi-chip',
    'a.btn-link',
    '.site-nav a',
    '.site-footer-links a',
    '.page-back',
    '.poster-report-link',
    '.specimen-cta',
    '.copilot-chip',
    '.copilot-clear',
    '.copilot-toggle',
    '.companion-local-form select', '.route-inspect select', '.walk-cta', '.journal-pick', '#journal-place',
  ].join(',');
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROL_SELECTOR)) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 纯行内文本链接（display:inline）的 rect 不含 padding，不算控件高度
    if (cs.display === 'inline') continue;
    // 亚像素容差：39.6px 会被浏览器四舍五入渲染成 40，不能算不达标
    if (r.height < 39.5) {
      const key = el.className + '|' + Math.round(r.height);
      if (seen.has(key)) continue;
      seen.add(key);
      out.smallTargets.push({
        cls: String(el.className || el.tagName).slice(0, 60),
        text: (el.textContent || '').trim().slice(0, 20),
        h: Math.round(r.height),
        w: Math.round(r.width),
      });
    }
  }

  // ---- 对比度：关键文本选择器 ----
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = [r, g, b].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  // 逐层向上找到不透明背景，再从上往下合成
  const effBg = (el) => {
    const layers = [];
    let node = el;
    while (node) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) {
        layers.push(bg);
        if (bg.a >= 0.999) break;
      }
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 }; // 默认纸/白底
    for (let i = layers.length - 1; i >= 0; i -= 1) base = over(layers[i], base);
    return base;
  };
  const CONTRAST_SELECTORS = [
    '.type-badge', '.poi-chip', '.poi-chip-rating', '.packing-source', '.packing-label',
    '.packing-reason', '.spot-name', '.spot-meta', '.spot-time', '.site-nav a',
    '.site-footer-links a', '.poster-sub', '.site-header .btn-primary', '.about-actions .btn-primary',
    '.about-lede', '.about-sections p', '.legal-inner p',
    '.specimen-cta', '.kpi-label', '.helper', '.muted', '.fault-desc',
    '.day-theme', '.warn-text', '.warn-tag', '.day-foot', '.recent-summary',
    '.firstscreen-title', '.firstscreen-lede', '.fs-card-tag', '.fs-card-note',
    '.fs-card-body', '.fs-warn-list li', '.firstscreen-points span', '.more-options-hint',
    // Trip Check 公开体验台：两轴结论 / 问题证据 / 诚实声明都是关键文本
    '.tc-lede', '.tc-axis-summary', '.tc-axis-note', '.tc-issue-detail', '.tc-honesty',
    '.tc-coverage-row', '.tc-cred-note', '.tc-cred-id', '.tc-empty',
    // Trip Check 修复区块（前后对比 / 修不了的原因 / 凭据链）
    '.tc-repair', '.tc-repair-compare', '.tc-repair-unrepairable', '.tc-repair-cred-id',
    // 工作台第五镜头「体检」（两轴 / 证据 / 修复预览与确认写入）
    '.tc-ws-check', '.tc-ws-check-lede', '.tc-ws-check-issue', '.tc-ws-check-unrepairable',
    // 可分享体检报告页（headline / 建议块 / 凭据）
    '.tc-report-page', '.tc-report-page-headline', '.tc-fix', '.tc-cred-id',
    '.at-journey-marks .btn', '.companion-page-heading p', '.companion-inline-link',
    '.companion-example-caption', '.companion-template p', '.companion-today-context',
    '.companion-today-actions a', '.companion-next-facts p', '.companion-next-facts a',
    '.route-caption', '.journal-dateline', '.journal-day', '.journal-jump', '.walk-deck', '.walk-cta', '.route-inspect a', '.field-departure p', '.footprint-map figcaption',
    '.companion-local-stop-time', '.companion-form-hint', '.companion-share-actions a', '.desk-lede',
  ];
  for (const sel of CONTRAST_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const cr = ratio(over(fg, { r: 255, g: 255, b: 255, a: 1 }), effBg(el));
    const need = large ? 3 : 4.5;
    if (cr < need) {
      out.contrast.push({ sel, ratio: Number(cr.toFixed(2)), need, size, color: cs.color });
    }
  }

  // ---- 可访问名：只有图标的按钮 ----
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const text = (el.textContent || '').trim();
    if (text) continue;
    const ok =
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('aria-labelledby');
    if (!ok) out.unnamedControls.push(String(el.className || el.tagName).slice(0, 60));
  }
  return JSON.stringify(out);
})()
`;

// ---------- 主流程 ----------
async function main() {
  if (!CHROME) {
    console.error("❌ 未找到 Chrome。设置 CHROME_PATH 后重试。");
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 快照 tsconfig.json：Next dev 启动时会往 tracked 的 tsconfig 里写当前 distDir
  // 的 types 路径（这里用的是 .next-visual-check），跑一次视觉门就让 git status
  // 变脏、还会让 format:check 假红（审计 P1-4）。跑完在 finally 里还原。
  let tsconfigSnapshot = null;
  try {
    tsconfigSnapshot = fs.readFileSync(path.join(ROOT, "tsconfig.json"), "utf8");
  } catch {
    /* 没有 tsconfig（理论上不会）就不管 */
  }

  let baseUrl = BASE_URL;
  let shareId = SHARE_ARG;
  let todayShareId = SHARE_ARG;
  let chromeProc = null;

  try {
    if (!baseUrl) {
      // 自起环境：桩 LLM + dev server（MOCK 高德，版面/可访问性检查不需要真实 key）
      const stubPort = await pickPort(8898);
      const devPort = await pickPort(3101);
      log(`▶ 启动桩 LLM :${stubPort} 与 dev server :${devPort}（首次编译稍慢）…`);
      spawnCmd("node", ["scripts/stub-llm.mjs", String(stubPort)]);
      spawnCmd(
        process.execPath,
        ["node_modules/next/dist/bin/next", "dev", "-p", String(devPort)],
        {
          NEXT_DIST_DIR: ".next-visual-check", // 独立构建目录：避免撞上开发者正在跑的 dev server（Next dev 锁按 distDir 生效）
          LLM_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
          LLM_API_KEY: "stub-key",
          LLM_MODEL: "step-5-preview",
          AMAP_WEB_SERVICE_KEY: "",
        },
      );
      baseUrl = `http://127.0.0.1:${devPort}`;
      if (!(await waitHttp(baseUrl))) throw new Error("dev server 未就绪");
    }
    log(`▶ 目标：${baseUrl}`);

    async function seedTrip(startOffset) {
      const ymd = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const seedStart = new Date(Date.now() + startOffset * 86_400_000);
      const seedEnd = new Date(seedStart.getTime() + 2 * 86_400_000);
      const post = await fetch(`${baseUrl}/api/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: "苏州",
          startAt: `${ymd(seedStart)}T10:00`,
          endAt: `${ymd(seedEnd)}T18:00`,
          budget: 2500,
          preferences: ["美食", "历史文化"],
        }),
      });
      const j = await post.json();
      if (post.status !== 202 || !j.jobId) throw new Error(`种子任务失败：${post.status}`);
      for (let i = 0; i < 240; i += 1) {
        const d = await (await fetch(`${baseUrl}/api/plan/status?id=${j.jobId}`)).json();
        if (d.status === "done" && d.shareId) return d.shareId;
        if (d.status === "error") throw new Error(`种子任务失败：${d.error}`);
        await sleep(500);
      }
      throw new Error("种子任务超时或缺少分享链接");
    }

    // 工作台需要出行前的规划镜头，今日页需要旅行中的执行面板。
    if (!shareId) {
      shareId = await seedTrip(7);
      todayShareId = await seedTrip(0);
      log(`▶ 种子行程：${shareId}`);
    }

    // Chrome
    // profile 放系统临时目录（每进程独立）：这个目录动辄几百个文件，放仓库里
    // 每次启动前整删既慢，也会撞上环境里的批量删除保护（一次性 unlink 超过
    // 阈值直接抛错，视觉门就假红）。临时目录 + 进程号隔离，脏了也不用管。
    const cdpPort = await pickPort(9333);
    const profile =
      process.env.VISUAL_PROFILE_DIR ||
      path.join(os.tmpdir(), `travel-partner-visual-profile-${process.pid}`);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) {
      log(`  ⚠️  旧 profile 清理失败（不影响本次检查）：${e.message}`);
    }
    chromeProc = spawnCmd(CHROME, [
      "--headless=new",
      "--disable-gpu",
      // 沙箱化环境（容器/受限 shell）里 Chrome 自身沙箱会初始化失败，
      // 用 VISUAL_CHROME_NO_SANDBOX=1 显式放开——仅在临时 profile 的
      // 一次性检查进程上使用，不影响日常浏览。
      ...(process.env.VISUAL_CHROME_NO_SANDBOX ? ["--no-sandbox"] : []),
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "about:blank",
    ]);
    const wsUrl = await openCdp(cdpPort);
    const cdp = await makeCdp(wsUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    // 明确设置两种模式，避免两次检查都跑成宿主机的深色主题。
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: darkTheme ? "dark" : "light" }],
    });

    const localTripStorage = `(() => {
          const timeZone = "Asia/Tokyo";
          const startDate = new Intl.DateTimeFormat("sv-SE", { timeZone, dateStyle: "short" }).format();
          const file = {
            format: "ai-travel-companion", version: 1,
            notes: [{
              id: "4476104a-05c7-4263-af2a-245642690e2e", at: "2026-11-19T05:15:00Z",
              place: "浅草寺", text: "刚走出寺门，听见巷口的风铃。"
            }],
            plan: {
              city: "东京", startDate, timeZone, summary: "", totalCostCny: 0, tips: [],
              days: [{
                day: 1, theme: "浅草", dailyCostCny: 0, transitMin: 0,
                spots: [{
                  stopId: "82c7fd7e-401e-494a-bb7f-3f032dbb26b3",
                  name: "浅草寺", area: "浅草", period: "morning", type: "sight",
                  time: "09:00-10:00", durationMin: 60, costCny: 0, reason: "",
                  navigationQuery: "浅草寺 東京都台東区浅草2-3-1",
                  openingHoursNote: {
                    hours: "本堂 06:00–17:00，10 月至次年 3 月 06:30 开门",
                    source: "浅草寺官网", url: "https://www.senso-ji.jp/visit/"
                  }
                }]
              }]
            }
          };
          localStorage.setItem("tp.local-trip-files.v1", JSON.stringify([JSON.stringify(file)]));
        })()`;

    const namedWalkStorage = `${localTripStorage}; (() => {
      const key = "tp.local-trip-files.v1";
      const files = JSON.parse(localStorage.getItem(key));
      const walk = JSON.parse(files[0]);
      walk.localId = "3e31a352-f046-4594-9a47-a242efe8c114";
      walk.walk = true;
      walk.title = "沿着隅田川看晚霞";
      walk.plan.city = "随走手记";
      walk.plan.days[0].spots = [];
      localStorage.setItem(key, JSON.stringify([JSON.stringify(walk), ...files]));
    })()`;

    const PAGES = [
      {
        name: "local",
        path: "/local",
        required: [
          ".companion-local",
          "input[type=file]",
          ".field-start-walk",
          ".local-walk-invite",
        ],
      },
      {
        name: "local-walk",
        path: "/local?open=walk",
        required: [
          ".journal-capture[open]",
          "#footprint-place",
          ".stop-capture-actions .btn-primary",
          ".journal-pages",
        ],
      },
      {
        name: "local-named-walk",
        path: "/local?trip=3e31a352-f046-4594-9a47-a242efe8c114",
        required: [".journal-title-editor[open]", "#walk-title", ".journal-entry"],
        storageSetup: namedWalkStorage,
        clicks: [".journal-title-editor summary"],
      },
      {
        name: "local-today",
        path: "/local",
        required: [
          ".day-route",
          ".today-hero .btn-primary",
          ".companion-next-facts a",
          ".today-timeline .companion-today-context",
          ".companion-local-calendar",
        ],
        storageSetup: localTripStorage,
        clicks: [".companion-trip .btn"],
      },
      {
        name: "local-journal",
        path: "/local?open=recent",
        required: [
          ".field-journal textarea",
          ".journal-pages",
          ".journal-entry",
          ".journal-pick input",
          "#journal-place",
          ".journal-day",
        ],
        storageSetup: localTripStorage,
        clicks: ['.companion-today-actions button[data-view="journal"]'],
      },
      {
        name: "local-editor",
        path: "/local",
        required: [".companion-local-form select", 'input[name="start"]', 'input[name="end"]'],
        storageSetup: localTripStorage,
        clicks: [
          ".companion-trip .btn",
          '.companion-today-actions[aria-label="本机行程视图"] button:last-child',
        ],
      },
      {
        name: "local-check",
        path: "/local",
        required: [".companion-local-check[open] .tc-axis", ".companion-local-check .tc-coverage"],
        storageSetup: localTripStorage,
        clicks: [".companion-trip .btn", ".companion-local-check summary"],
      },
      {
        // 首页要能直接开始新行程，同时保留示例入口。
        name: "trips",
        path: "/",
        required: [
          ".trips-home",
          ".app-topbar",
          ".companion-page-heading",
          ".field-start-walk",
          ".walk-cover .walk-cta",
          ".companion-start-form",
          ".companion-example",
          ".companion-template-list",
        ],
      },
      {
        // 已有行程首页：验证「进行中优先 / 想去 / 最近行程」在真实数据下的布局。
        // 空态和列表态是两条完全不同的渲染分支，只截空态会漏掉列表回归。
        name: "trips-populated",
        path: "/",
        required: [
          ".companion-trip-list",
          ".companion-trip[data-active]",
          '.companion-home-section[aria-label="想去"]',
        ],
        storageSetup: `(() => {
          const pad = (n) => String(n).padStart(2, "0");
          const ymd = (offset) => {
            const d = new Date();
            d.setDate(d.getDate() + offset);
            return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
          };
          localStorage.setItem("tp.recent-trips.v1", JSON.stringify([
            { shareId: "share_visual_active", city: "上海", days: 3, startDate: ymd(0), summary: "外滩与梧桐区，三天慢走。", createdAt: Date.now() },
            { shareId: "share_visual_next", city: "成都", days: 4, startDate: ymd(30), createdAt: Date.now() - 1000 }
          ]));
          localStorage.setItem("tp.wishlist.v1", JSON.stringify([
            { shareId: "share_visual_wish", city: "大理", days: 4, startDate: ymd(60), summary: "环洱海与古城", addedAt: Date.now() }
          ]));
          return true;
        })()`,
      },
      {
        // 新建页：核心三字段 + 首屏内可见的主 CTA
        name: "new",
        path: "/new",
        required: [".new-head", ".new-core", ".new-core-actions", ".more-options"],
      },
      {
        name: "check",
        path: "/check",
        required: [".check-desk", ".desk-textarea", ".desk-actions"],
      },
      {
        name: "about",
        path: "/about",
        required: [".about-hero", "#how", "#trust", ".site-footer"],
      },
      { name: "privacy", path: "/privacy", required: [".legal-page", ".site-footer"] },
      // Trip Check 公开体验台（开放核验标准的产品面）：贴文档→两轴报告→凭据
      {
        name: "verify",
        path: "/verify",
        required: [".tc-page", ".tc-hero", ".tc-playground", ".tc-panel"],
      },
      // B2 城市模板（SEO 获取层）：列表页 + 详情页都要参与移动端回归
      { name: "cities", path: "/cities", required: [".cities-page", ".cities-grid"] },
      {
        name: "city-detail",
        path: "/cities/chengdu",
        required: [".cities-page", ".cities-variants"],
      },
      { name: "terms", path: "/terms", required: [".legal-page", ".site-footer"] },
      {
        name: "workspace",
        path: `/w/${shareId}`,
        required: [".trip-workspace", ".ws-tabs", ".ws-daynav"],
      },
      {
        // 第五镜头「体检」：两轴报告 + 修复预览/确认写入（数据来自 /api/plan/check）
        name: "workspace-check",
        path: `/w/${shareId}?view=check`,
        required: [".trip-workspace", ".ws-tabs", ".tc-ws-check"],
      },
      {
        // 可分享体检报告页：公开工件（两轴 + 规则证据 + 凭据 + 传播动作）
        name: "share-check",
        path: `/p/${shareId}/check`,
        required: [".tc-report-page", ".tc-report", ".tc-issue"],
      },
      {
        name: "share",
        path: `/p/${shareId}`,
        required: [
          ".poster",
          ".packing-card",
          ".day-head",
          ".app-topbar",
          ".companion-share-actions",
        ],
      },
      { name: "report", path: `/r/${shareId}`, required: [".report-poster", ".app-topbar"] },
      {
        name: "trip",
        path: `/t/${todayShareId}`,
        required: [".today-root", ".app-topbar", ...(SHARE_ARG ? [] : [".at-journey-marks"])],
      },
    ];
    const VIEWPORTS = [
      { name: "desktop", width: 1440, height: 900 },
      { name: "mobile", width: 390, height: 844 },
    ];

    const report = { baseUrl, shareId, at: new Date().toISOString(), pages: [] };

    for (const vp of VIEWPORTS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        mobile: vp.name === "mobile",
      });
      for (const page of PAGES) {
        log(`\n== ${page.name} @ ${vp.width}×${vp.height} ==`);
        cdp.errors.length = 0;
        // 某些页面需要真实 localStorage 数据才能进入列表态：先在同一 origin
        // 完成一次导航，再写 storage，最后导航到目标页。
        if (page.storageSetup) {
          await cdp.send("Page.navigate", { url: `${baseUrl}/robots.txt` });
          await sleep(500);
          await cdp.send("Storage.clearDataForOrigin", {
            origin: new URL(baseUrl).origin,
            storageTypes: "local_storage,indexeddb",
          });
          const seeded = await cdp.send("Runtime.evaluate", {
            expression: page.storageSetup,
            returnByValue: true,
          });
          if (seeded.exceptionDetails) {
            fail(`${page.name}/${vp.name} 写入 localStorage 失败`);
          }
        }
        await cdp.send("Page.navigate", { url: `${baseUrl}${page.path}` });
        await sleep(3000); // 等 hydration + 懒加载地图请求
        for (const selector of page.clicks ?? []) {
          await cdp.send("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(selector)})?.click()`,
          });
          await sleep(250); // 等本机行程读完并挂载时钟
        }

        const res = await cdp.send("Runtime.evaluate", {
          expression: PAGE_CHECK_FN,
          awaitPromise: true,
          returnByValue: true,
        });
        const check = JSON.parse(res.result.value);
        const pageResult = {
          page: page.name,
          viewport: vp.name,
          ...check,
          errors: [...cdp.errors],
        };

        // 断言
        const ov = check.overflow;
        if (ov.scrollWidth > ov.clientWidth + 1) {
          fail(`${page.name}/${vp.name} 横向溢出 ${ov.scrollWidth} > ${ov.clientWidth}`);
        } else {
          log(`  ✅ 无横向溢出（${ov.clientWidth}px）`);
        }
        if (check.smallTargets.length) {
          for (const t of check.smallTargets.slice(0, 8)) {
            fail(`${page.name}/${vp.name} 触控目标偏小 ${t.h}px ${t.cls}「${t.text}」`);
          }
          if (check.smallTargets.length > 8)
            warn(`${page.name}/${vp.name} 另有 ${check.smallTargets.length - 8} 处偏小目标未列出`);
        } else {
          log("  ✅ 触控目标 ≥ 40px");
        }
        if (check.contrast.length) {
          for (const c of check.contrast.slice(0, 8)) {
            fail(`${page.name}/${vp.name} 对比度不足 ${c.ratio}:1（需 ${c.need}）${c.sel}`);
          }
        } else {
          log("  ✅ 关键文本对比度达标");
        }
        if (pageResult.errors.length) {
          for (const e of pageResult.errors.slice(0, 5))
            fail(`${page.name}/${vp.name} 控制台异常：${e}`);
        } else {
          log("  ✅ 无控制台异常");
        }
        if (check.unnamedControls.length) {
          warn(
            `${page.name}/${vp.name} 有 ${check.unnamedControls.length} 个无名称图标按钮：${check.unnamedControls.slice(0, 3).join(", ")}`,
          );
        }
        for (const sel of page.required) {
          const has = await cdp.send("Runtime.evaluate", {
            expression: `Boolean(document.querySelector(${JSON.stringify(sel)}))`,
            returnByValue: true,
          });
          if (!has.result.value) fail(`${page.name}/${vp.name} 缺少关键元素 ${sel}`);
        }

        // 截图（全页，限制高度避免超大图）
        const metrics = await cdp.send("Page.getLayoutMetrics");
        const fullH = Math.min(Math.ceil(metrics.cssContentSize.height), 8000);
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 72,
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: vp.width, height: fullH, scale: 1 },
        });
        const file = path.join(OUT_DIR, `${page.name}-${vp.name}.jpg`);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        pageResult.screenshot = path.relative(ROOT, file);
        report.pages.push(pageResult);

        // 清理播种数据，避免污染后面的分享页/工作台检查。
        if (page.storageSetup) {
          await cdp.send("Page.navigate", { url: `${baseUrl}/robots.txt` });
          await sleep(350);
          await cdp.send("Storage.clearDataForOrigin", {
            origin: new URL(baseUrl).origin,
            storageTypes: "local_storage,indexeddb",
          });
        }
      }
    }

    cdp.close();
    fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

    log(`\n结果：${failures.length} 个失败 / ${warnings.length} 个警告`);
    log(`截图与报告：${path.relative(ROOT, OUT_DIR)}/`);
    if (failures.length) {
      log("失败项：");
      for (const f of failures) log(`  - ${f}`);
      process.exitCode = 1;
    }
  } finally {
    teardown();
    if (chromeProc) {
      try {
        chromeProc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    // 还原被 Next dev 改写的 tsconfig（见上方快照注释）：只还原内容，
    // 不碰 git。失败也不影响检查结果——最多保持原样。
    if (tsconfigSnapshot !== null) {
      try {
        const tsconfigPath = path.join(ROOT, "tsconfig.json");
        if (fs.readFileSync(tsconfigPath, "utf8") !== tsconfigSnapshot) {
          fs.writeFileSync(tsconfigPath, tsconfigSnapshot);
          log("↩︎ 已还原 tsconfig.json（Next dev 运行时改写）");
        }
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error("❌ 视觉检查异常终止：", e);
  teardown();
  process.exit(1);
});
