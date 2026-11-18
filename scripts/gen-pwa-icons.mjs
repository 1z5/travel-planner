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

// 同一份矢量源同时用于浏览器和安装图标，避免两套标记漂移。
const source = fs.readFileSync(path.join(ROOT, "app/icon.svg"));

const TARGETS = [
  { file: "public/icons/icon-192.png", size: 192 },
  { file: "public/icons/icon-512.png", size: 512 },
  { file: "public/apple-touch-icon.png", size: 180 },
];

for (const t of TARGETS) {
  const out = path.join(ROOT, t.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await sharp(source, { density: 384 }).resize(t.size, t.size).png().toFile(out);
  console.log(`✅ ${t.file}（${t.size}×${t.size}）`);
}
