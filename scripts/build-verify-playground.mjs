#!/usr/bin/env node
// ============================================================
// 生成 public/verify-playground.html：一个自包含、零后端的验真页面
//
// 为什么把 bundle 内联进 HTML 而不是让页面引 /static/*.js：目标是「双击就能用」
// ——file:// 打开、离线、可以直接发 GitHub Pages，不需要 Next 服务，也不需要
// 同源策略放行。配合模板里的 CSP（connect-src 'none'），页面物理上无法发请求。
//
// 产物提交进仓库（public/）：这是给访客的成品，不是构建缓存。改了引擎/模板后
// 必须重跑 npm run playground:build，tests/cli/playground.test.ts 会核对产物。
// ============================================================

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "node_modules/.cache/verify-playground");
const bundlePath = resolve(outDir, "trip-check.js");
const templatePath = resolve(root, "cli/playground.template.html");
const outputPath = resolve(root, "public/verify-playground.html");
const PLACEHOLDER = "/*__TRIP_CHECK_BUNDLE__*/";

await build({
  configFile: false,
  logLevel: "error",
  resolve: {
    // 依赖图里已无 server-only，但保留别名作为防御（以后误引入服务端模块会静默通过）
    alias: { "server-only": resolve(root, "cli/server-only-stub.ts") },
  },
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    lib: {
      entry: resolve(root, "cli/playground-entry.ts"),
      name: "TripCheck",
      formats: ["iife"],
      fileName: () => "trip-check.js",
    },
    outDir,
    emptyOutDir: true,
    target: "es2022",
    minify: true,
  },
});

const js = (await readFile(bundlePath, "utf8")).replaceAll("</script", "<\\/script");
const template = await readFile(templatePath, "utf8");
if (!template.includes(PLACEHOLDER)) {
  throw new Error("模板缺少 bundle 占位符，拒绝生成半成品");
}
// 必须用函数式 replacement：`String.replace(search, 替换字符串)` 会把替换串里的
// `$&` / `$'` / `$`` 当成特殊标记展开，而压缩后的 zod 正含有这些字符序列——
// 用字符串替换会把占位符或整段模板重新注入 bundle，产出一个语法坏掉却仍会写盘的 HTML。
await writeFile(
  outputPath,
  template.replace(PLACEHOLDER, () => js),
  "utf8",
);
console.log(`已生成 ${outputPath}（内联 bundle ${(js.length / 1024).toFixed(0)} KiB）`);
