# ADR-017: Trip Check CLI——把「可复算」从主张变成 10 秒可验证的事实

## 状态

已接受（2026-11-10，CLI 已落地：`cli/` + `npm run trip:check`）

## 背景

ADR-012/013 把核验做成了开放标准：确定性引擎 + 可复算凭据 + 确定性修复。
但标准的**第一承诺——「任何人都能独立复算同一结论」——此前只兑现了一半**：

- 引擎 `lib/verify/engine.ts` 文件头自述「可在浏览器/Node/测试里跑同一份规则」，
  实际上它只跑在我们的服务器后面，要触达必须走 HTTP API；
- 第三方想复算一个凭据 ID，得先 clone 仓库、装依赖、起 Next 服务、再 POST
  `/api/verify`——这个门槛等于把「可复算」降级成了「相信我」；
- 同一障碍也压着展示面：仓库放在 GitHub 个人主页上，访客第一眼看 README，
  而演示站（Render 免费实例）冷启动 30–60 秒，访客等不到。

2026-11-10 的仓库评审结论：本项目最有价值的资产不是「行程生成」（已被商品化），
而是「AI 产出物的机械验真」。这个资产应该有一个**不依赖 LLM key、不依赖高德 key、
不依赖我们的服务器**的触达形态。

## 决策

1. **新增 `cli/`：Trip Check 命令行工具**（`npm run trip:check -- <file.json>`，
   内置 `--sample verified/blocked/unverified`）。
   - 输入只接受已成形的 Trip Check v0.1 JSON：**不调 LLM 做文本抽取**
     （那是 `/api/verify/extract` 的职责，需要 key 且结果不确定）；
   - 判定与修复完全走既有的 `engine.ts` / `repair.ts` / `credential.ts`，
     与 API/MCP 同一口径——CLI 不另开一套判定，否则「同一结论」就是假的；
   - `--fix` 输出确定性修复动作 + **前后两张凭据**；
   - `--json` 机读输出；退出码 `0` 通过 / `1` 阻断（`--strict` 含提醒与未核验） /
     `2` 输入非法——可以直接进 CI。
2. **运行方式是「每次用 vite（rolldown）现打一个 SSR bundle」**
   （`scripts/trip-check.mjs`，产物落 `node_modules/.cache/`）：
   - lib 用 bundler 风格的无扩展名相对 import，Node 的 type-stripping 跑不了；
   - 打包顺手把 `server-only` 别名为空桩（CLI 本来就是 Node 环境，标记语义不变）、
     把 zod 打进单文件；
   - 不做 mtime 增量缓存：rolldown 打这个量级 < 1 秒，「改了引擎立刻生效」
     比省这一秒重要，且永远不会过期。
3. **格式与参数解析拆成纯函数**（`cli/report-format.ts` / `cli/args.ts`），
   IO 全部注入——CLI 的门面输出必须能被 vitest 直接断言，不许混在 fs/argv 里。
4. **同轮叙事清理**（与 CLI 同 commit family，都是「展示项目就该有展示项目的样子」）：
   - `/pricing` 从「投票收集意愿」改成纯历史留档页（删除 `IntentButton` 与
     `upgrade_intent` 上报；URL 保留不 404，因为旧链接已被分享/收录）；
   - `/pricing` 移出 sitemap（不主动向搜索引擎展示一个作废页面）；
   - Node 版本口径统一为 >=22（`engines` / `.nvmrc` / `preflight.mjs` 三处一致）。

## 刻意不做（本轮的边界）

- **不发 npm 包**：发布需要 registry 账号与长期维护承诺，本项目明确不做维护承诺。
  CLI 以仓库内 `npm run` 形态提供；`bin` 入口与发包是未来的可选项，不预埋半成品。
- **不动登录体系**：短信/微信登录（6 条路由 + SmsCode 表）对「分享 token 即能力」的
  展示项目确实是冗余攻击面，但它牵涉 store schema、e2e 契约与配额链路，
  是一次独立的删除手术，不该夹带在本轮里。候选，未排期。
- **不改首页形态**：`/` 维持「我的行程」。「首屏改为证据台（真实行程 + 三条问题 +
  凭据 ID）」是下一轮候选，需要重做 `TripsHome` 的展示契约测试，独立进行。
- **不做浏览器端 bundle**：引擎本身是 client-safe 纯函数（仅 `credential.ts` 用了
  `node:crypto`，可换 Web Crypto），把 `/check` 变成「本地算凭据、不上传」是
  消除冷启动 + 强化「不需要信任服务器」叙事的正确下一步。候选，未排期。

## 后果

- 「任何人都能复算」第一次成为**可动手验证**的事实：`npm run trip:check -- --sample verified`
  在任何机器上输出同一个 `tc_bf64bc25…`；这一行已经写进 README 作为门面。
- CLI 成为标准的最小可分发形态：不依赖 Web 应用存活，演示站宕机也不影响验真的可信度。
- 定价页与站点叙事一致（免费、开源、留档），消除了「宣布放弃商业化但挂着投票页」的矛盾。
- 新的维护责任：`cli/` 的测试并入单测门禁；引擎行为变化会同时改变 CLI 输出，
  凭据 ID 因此保持跨形态一致（这正是设计意图，不算负担）。
