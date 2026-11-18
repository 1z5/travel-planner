#!/usr/bin/env node
// ============================================================
// 生成 GitHub 门面图片（Chrome headless 渲染真实 HTML，不手写 SVG）
//
// 产出：
// - docs/images/social-preview.png  1280×640，仓库 Settings → Social preview 用
//
// 为什么用脚本生成而不是提交一张截图：文案里的规则数、引擎版本、凭据 ID 都会变，
// 图必须能重生成；Node 里没有可靠的 SVG 光栅化器，Chrome headless 在这台机器上
// 现成可用（与 gate:visual 同源）。临时 HTML 落在系统临时目录，不进仓库。
// ============================================================

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "docs/images");
mkdirSync(outDir, { recursive: true });

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error("找不到 Chrome；可设 CHROME_PATH 指定可执行文件");

const FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

const CRED = "tc_46031b8729399c8d94e0f7cd48f2629c";

const socialHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{width:1280px;height:640px;background:#0a1119;color:#e8eef6;font-family:${FONT};overflow:hidden;position:relative}
body:before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 88% 12%,rgba(29,158,117,.16),transparent 46%)}
.wrap{position:relative;padding:62px 72px;height:100%;display:flex;flex-direction:column}
.eyebrow{font:13px/1 ${MONO};letter-spacing:.16em;color:#5dcaa5}
h1{font-size:60px;line-height:1.16;margin-top:24px;font-weight:600;letter-spacing:-1px}
.hl{color:#5dcaa5}
.sub{margin-top:18px;font-size:22px;color:#9fb0c3;line-height:1.5}
.terminal{margin-top:34px;width:660px;background:#111c27;border:1px solid #24313f;border-radius:12px;padding:20px 24px;font:15px/1.85 ${MONO}}
.terminal .cmd{color:#5dcaa5}.terminal .bad{color:#f09595}.terminal .dim{color:#7d8ea1}.terminal .id{color:#85b7eb}
.right{position:absolute;right:72px;top:196px;width:390px;border:1px solid #24313f;background:#101a24;border-radius:12px;padding:26px}
.right .t{font-size:14px;color:#7d8ea1;letter-spacing:.08em}
.row{display:flex;justify-content:space-between;align-items:center;padding:15px 0;border-bottom:1px solid #1d2936;font-size:17px}
.row:last-of-type{border-bottom:0}
.row b{font:13px/1 ${MONO};color:#5dcaa5;font-weight:400}
.same{margin-top:18px;text-align:center;font:13px/1.5 ${MONO};color:#85b7eb;word-break:break-all}
.foot{margin-top:auto;display:flex;justify-content:space-between;font:14px/1 ${MONO};color:#63768a}
</style></head><body><div class="wrap">
<div class="eyebrow">TRIP CHECK · OPEN STANDARD v0.1</div>
<h1>AI 行程的<br><span class="hl">可复算机械验真</span></h1>
<p class="sub">16 条确定性规则，判定不调模型。<br>同一文档 + 同一规则版本 → 同一凭据 ID。</p>
<div class="terminal">
<div><span class="cmd">$</span> npm run trip:check -- --sample blocked</div>
<div><span class="bad">✗ TC-C102</span> <span class="dim">两段时间重叠 30 分钟</span></div>
<div><span class="bad">✗ TC-F204</span> <span class="dim">苏州博物馆 · 周一闭馆</span></div>
<div><span class="bad">✗ TC-F202</span> <span class="dim">地点在事实源中查不到</span></div>
<div class="dim">凭据 <span class="id">${CRED.slice(0, 20)}…</span></div>
</div>
<div class="right">
<div class="t">同一个凭据 ID，三处独立复算</div>
<div class="row"><span>命令行 CLI</span><b>离线 · 零 key</b></div>
<div class="row"><span>公开 API / MCP</span><b>无状态</b></div>
<div class="row"><span>浏览器本地</span><b>不上传</b></div>
<div class="same">${CRED}</div>
</div>
<div class="foot"><span>github.com/1z5/AI-Travel-Companion</span><span>Next.js 16 · TypeScript 7 · Apache-2.0</span></div>
</div></body></html>`;

function shot(name, htmlBody, width, height) {
  const tmpHtml = join(tmpdir(), `trip-check-${name}-${process.pid}.html`);
  writeFileSync(tmpHtml, htmlBody, "utf8");
  const out = resolve(outDir, `${name}.png`);
  execFileSync(
    chrome,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=2500",
      `--screenshot=${out}`,
      `file://${tmpHtml}`,
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  console.log(`已生成 ${out}（${width}×${height}）`);
}

shot("social-preview", socialHtml, 1280, 640);
