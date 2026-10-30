#!/usr/bin/env node
/**
 * 生成 PWA 图标（manifest icons + apple-touch-icon）。
 *
 * 为什么用脚本而不是手贴 PNG：图标要随品牌色调整，仓库里放源 SVG + 生成脚本，
 * 改品牌色只改一处；PNG 是生成物，随提交进 public/（部署产物需要真实文件）。
 *
 * 用法：node scripts/gen-pwa-icons.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 品牌源图（ATLAS v6）：冷瓷底 + 珊瑚渐变圆角方块 + 白色「行」字。
// 与页头 brand-mark 同一语言：渐变方向 150deg、上缘高光、字形用衬线（印章感）。
// sharp 用 libvips 渲染 SVG，文字依赖系统字体（macOS 宋体/苹方，CI 有回退）；
// 换 CI 镜像时需确认字体存在，否则「行」会退化成方框。
const SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="#ff7a4d"/>
      <stop offset="0.55" stop-color="#e2451c"/>
      <stop offset="1" stop-color="#b42a0c"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#ff5e33" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#ff5e33" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" fill="#edf1f7"/>
  <circle cx="256" cy="286" r="190" fill="url(#glow)"/>
  <rect x="88" y="88" width="336" height="336" rx="104" fill="url(#tile)"/>
  <rect x="88" y="88" width="336" height="336" rx="104" fill="url(#sheen)"/>
  <text x="256" y="268" font-family="Songti SC, STSong, SimSun, serif" font-size="196"
        font-weight="700" text-anchor="middle" dominant-baseline="central" fill="#fffdf7">行</text>
</svg>`;

const TARGETS = [
  { file: "public/icons/icon-192.png", size: 192 },
  { file: "public/icons/icon-512.png", size: 512 },
  { file: "public/apple-touch-icon.png", size: 180 },
];

for (const t of TARGETS) {
  const out = path.join(ROOT, t.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(Buffer.from(SOURCE)).resize(t.size, t.size).png().toFile(out);
  console.log(`✅ ${t.file}（${t.size}×${t.size}）`);
}
