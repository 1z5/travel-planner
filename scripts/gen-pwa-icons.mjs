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

// 品牌源图：暖纸底 + 陶土橙圆角方块 + 墨色「行」字（与 brand-mark 同一语言）。
// 文字用通用衬线栈：sharp 用 libvips 渲染 SVG，本机有中文字体（macOS 宋体/苹方），
// CI 上同样有系统字体回退；若未来换 CI 镜像需确认字体存在。
const SOURCE = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#f6f0e4"/>
  <rect x="96" y="96" width="320" height="320" rx="72" fill="#c2410c"/>
  <text x="256" y="256" font-family="Songti SC, STSong, SimSun, serif" font-size="176"
        text-anchor="middle" dominant-baseline="central" fill="#f6f0e4">行</text>
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
