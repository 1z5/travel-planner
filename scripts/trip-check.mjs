#!/usr/bin/env node
// ============================================================
// Trip Check CLI 启动器：打包（vite SSR bundle）→ 调 cli/trip-check.ts 的 run()
//
// 为什么要打包而不是直接跑 TS：lib/ 用的是 bundler 风格的无扩展名相对 import，
// Node 的 type-stripping 解析不了；打包顺手把 "server-only" 别名为空桩、把 zod
// 打进单文件——产物离线可跑、不依赖本仓库的 node_modules。
//
// 产物落在 node_modules/.cache/：node_modules 整体已被 .gitignore 覆盖，
// 不需要新增忽略规则，也不会污染仓库树。
// ============================================================

import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "node_modules/.cache/trip-check");
const outFile = resolve(outDir, "trip-check.mjs");

// 每次重新打包：rolldown 打包这个量级 < 1s，换来「改了引擎立刻生效」，
// 比维护 mtime 增量缓存简单且不会过期（CLI 的 correctness > 1 秒）。
await build({
  configFile: false,
  logLevel: "error",
  resolve: {
    alias: { "server-only": resolve(root, "cli/server-only-stub.ts") },
  },
  // 把 zod 等依赖打进 bundle：CLI 的卖点是单文件自包含
  ssr: { noExternal: true },
  build: {
    ssr: resolve(root, "cli/trip-check.ts"),
    outDir,
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "trip-check.mjs", format: "es" },
    },
  },
});

const { run } = await import(pathToFileURL(outFile).href);
process.exitCode = await run(process.argv.slice(2));
