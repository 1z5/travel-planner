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
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "eval-results", "visual");

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
}
const BASE_URL = opt("base-url");
const SHARE_ARG = opt("share");
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
    '.footer-col a',
    '.page-back',
    '.poster-report-link',
    '.specimen-cta',
    '.copilot-chip',
    '.copilot-clear',
    '.copilot-toggle',
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
    '.footer-col a', '.trust-meta', '.stat-label', '.poster-sub', '.pp-meta', '.pp-note',
    '.pp-dayno', '.specimen-cta', '.kpi-label', '.helper', '.muted', '.fault-desc',
    '.day-theme', '.warn-text', '.warn-tag', '.day-foot', '.recent-summary',
    '.firstscreen-title', '.firstscreen-lede', '.fs-card-tag', '.fs-card-note',
    '.fs-card-body', '.fs-warn-list li', '.firstscreen-points span', '.more-options-hint',
    // Trip Check 公开体验台：两轴结论 / 问题证据 / 诚实声明都是关键文本
    '.tc-lede', '.tc-axis-summary', '.tc-axis-note', '.tc-issue-detail', '.tc-honesty',
    '.tc-coverage-row', '.tc-cred-note', '.tc-cred-id', '.tc-empty',
    // Trip Check 修复区块（前后对比 / 修不了的原因 / 凭据链）
    '.tc-repair', '.tc-repair-compare', '.tc-repair-unrepairable', '.tc-repair-cred-id',
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

// ---------- Chrome / CDP ----------
async function openCdp(port) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up */
    }
    await sleep(150);
  }
  throw new Error("Chrome DevTools 不可达");
}

function makeCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
        return;
      }
      if (msg.method === "Runtime.exceptionThrown") {
        errors.push(
          `exception: ${msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "unknown"}`,
        );
      }
      if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
        if (!/React DevTools|HMR|Fast Refresh/.test(text))
          errors.push(`console.error: ${text.slice(0, 200)}`);
      }
      if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
        const text = msg.params.entry.text ?? "";
        if (!/React DevTools|HMR|Fast Refresh|favicon/.test(text))
          errors.push(`log.error: ${text.slice(0, 200)}`);
      }
    });
    ws.addEventListener("open", () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      resolve({ send, errors, close: () => ws.close() });
    });
    ws.addEventListener("error", reject);
  });
}

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

    // 种子数据：3 天苏州（stub fixture），拿 share token 测 /p /r /t
    if (!shareId) {
      // 日期必须**相对今天**计算，不能硬编码：硬编码会随时间漂移——
      // 一旦今天恰好是行程首日，TripWorkspace 会自动切到「今日」镜头
      //（今日镜头没有 .ws-daynav 日导航），视觉门就报「缺少关键元素」；
      // 行程整体过去后又会测不到真实内容镜头。固定 +7 天出发、3 天行程，
      // 永远落在「出行前」状态。
      const ymd = (d) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const seedStart = new Date(Date.now() + 7 * 86_400_000);
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
        if (d.status === "done") {
          shareId = d.shareId;
          break;
        }
        if (d.status === "error") throw new Error(`种子任务失败：${d.error}`);
        await sleep(500);
      }
      if (!shareId) throw new Error("种子任务超时");
      log(`▶ 种子行程：${shareId}`);
    }

    // Chrome
    const cdpPort = await pickPort(9333);
    const profile = path.join(OUT_DIR, ".chrome-profile");
    fs.rmSync(profile, { recursive: true, force: true });
    chromeProc = spawnCmd(CHROME, [
      "--headless=new",
      "--disable-gpu",
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

    const PAGES = [
      {
        // 新用户首屏验收标准：主张、主 CTA、可溯源证据都必须在场
        // （缺一项就说明「第一屏传递重要信息/引导明确/可记忆亮点」被改坏了）
        name: "trips",
        path: "/",
        required: [
          ".trips-home",
          ".app-topbar",
          ".home-action",
          ".firstscreen-title",
          ".firstscreen-cta",
          ".home-examples",
          ".firstscreen-evidence",
        ],
      },
      {
        // 新建页：核心三字段 + 首屏内可见的主 CTA
        name: "new",
        path: "/new",
        required: [".new-head", ".new-core", ".new-core-actions", ".more-options"],
      },
      {
        name: "about",
        path: "/about",
        required: [".about-hero", ".trust-grid", ".site-footer"],
      },
      { name: "privacy", path: "/privacy", required: [".legal-page", ".site-footer"] },
      // Trip Check 公开体验台（开放核验标准的产品面）：贴文档→两轴报告→凭据
      {
        name: "verify",
        path: "/verify",
        required: [".tc-page", ".tc-hero", ".tc-playground", ".tc-panel"],
      },
      // 定价/意愿页（S3 商业化试点）
      { name: "pricing", path: "/pricing", required: [".pricing-page", ".pricing-grid"] },
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
        name: "share",
        path: `/p/${shareId}`,
        required: [".poster", ".packing-card", ".day-head", ".app-topbar"],
      },
      { name: "report", path: `/r/${shareId}`, required: [".report-poster", ".app-topbar"] },
      { name: "trip", path: `/t/${shareId}`, required: [".today-root", ".app-topbar"] },
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
        await cdp.send("Page.navigate", { url: `${baseUrl}${page.path}` });
        await sleep(3000); // 等 hydration + 懒加载地图请求

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
