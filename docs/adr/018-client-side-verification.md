# ADR-018: 凭据层同构化 + 离线验真台——把服务器从信任链里移除

## 状态

已接受（2026-11-10，`lib/verify/sha256.ts` / `public/verify-playground.html` 已落地）

## 背景

ADR-017 交付了 CLI，让「任何人都能独立复算」第一次可动手验证。但还有一个更根本的
不一致没解决：

- `lib/verify/engine.ts` 文件头写着「可在浏览器/Node/测试里跑同一份规则」，
  `types.ts` 也写着「不 import server-only、不发网络请求」；
  而 `credential.ts` 却同时 `import "server-only"` 与 `node:crypto`。
  **判定能在浏览器跑，凭据不能** —— 浏览器里算出的报告无法对账，开放标准仍不完整；
- 上一轮评审指出演示站（Render 免费实例）冷启动 30–60 秒是 GitHub 访客的最大流失点。
  只要验真必须走 HTTP，这个流失点就消不掉；
- 更本质的是叙事问题：一个主张「不需要信任平台」的核验标准，却要求访客把行程
  发给平台的服务端才能看到结论。

## 决策

1. **自己实现同构 SHA-256**（`lib/verify/sha256.ts`，约 90 行纯 JS，FIPS 180-4）。
   - 不用 `crypto.subtle.digest`：它是异步的，会把同步纯函数 `credentialOf()` 变成
     Promise，牵动 13 处调用点，并让「修复前后两张凭据」依赖时序；
   - 不引第三方哈希库：凭据口径是开放标准的一部分，第三方要能用任意语言复算，
     多一层依赖就多一层版本漂移；
   - `credential.ts` 去掉 `server-only` 与 `node:crypto`，改调 `sha256HexUtf8()`。
     函数签名、语义、ID 口径一个字节都没变。
2. **用测试冻结这个承诺**：`tests/lib/verify/sha256.test.ts` 与 `node:crypto` 逐用例
   对拍（标准向量、中文、emoji、控制字符、55/56/63/64/65 字节补位边界、跨块长输入），
   并把 README / CLI 输出里已公开的三个凭据 ID 写成回归断言。**换哈希实现必须先让
   测试红**，否则分享页与文档里的凭据会集体失效。
3. **交付单文件离线验真台** `public/verify-playground.html`：
   - `cli/playground-entry.ts` 复用同一套 `verifyDocument` / `repairDocument` /
     `credentialOf`，由 `scripts/build-verify-playground.mjs` 打成 IIFE 并**内联进 HTML**；
   - 模板 CSP 写死 `default-src 'none'; connect-src 'none'`：页面物理上无法发请求，
     「不上传」不是承诺而是约束；
   - 产物提交进仓库（给访客的成品，不是构建缓存），支持 `#verified` / `#blocked` /
     `#unverified` 直接链到跑完的结果；
   - `tests/cli/playground.test.ts` 真的执行产物里的内联 bundle，断言浏览器算出的
     凭据 ID 与 CLI / API 完全相同（含 `--fix` 的前后凭据链）。真实 Chrome headless
     也已用它跑出 `tc_46031b87…`。
4. **门面资产脚本化**：`scripts/build-showcase-images.mjs` 用 Chrome headless 渲染
   `docs/images/social-preview.png`（1280×640）与 `readme-hero.png`（1280×560）。
   不手写 SVG / 不提交一次性截图：文案里的规则数、版本、凭据 ID 会变，图必须能重生成。

## 踩坑记录（务必保留）

- **`String.replace(placeholder, bundledCode)` 会毁掉产物**：压缩后的 zod 代码里含
  `$&` / `$'` 等替换标记，字符串式 replacement 会把占位符甚至整段模板重新注入
  bundle，生成一个「文件写成功了但脚本语法坏掉」的 HTML。必须用函数式替换
  `replace(placeholder, () => code)`。构建脚本里已写明原因。
- **vitest 的 jsdom 环境不提供 `TextEncoder`**：测试用例里从 `node:util` 注入，
  浏览器与 Node 本身都原生提供，不需要 polyfill 进产物。

## 后果

- 判定 / 修复 / 凭据三层全部 client-safe；`lib/verify` 的这条依赖图里已无 `node:` 内建，
  引擎文件头那句「浏览器可跑」终于名副其实。
- 技术故事从「我做了个网站」变成「验真不需要信任任何服务器」：CLI、API、浏览器
  三个独立环境产出同一个 `tc_46031b87…`，有测试与真实浏览器双重证据。
- GitHub 访客多了一条不依赖 Render 是否活着的路径：clone 后双击 HTML 即可，
  或直接发 GitHub Pages。
- 代价：产物约 257 KB（内联 bundle 116 KiB）；改了引擎、模板或门面文案必须重跑
  `npm run playground:build` / `build-showcase-images.mjs`，已写进 docs/README.md 维护约定。

## 仍未做（下一轮候选，不排期）

发 npm 包 + `bin` 入口；首页改「证据台」；删除短信/微信登录体系；
用真实语料产出一份可复算的「AI 行程错误率」一手数据报告（不引用二手 43%）。
