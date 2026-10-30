# 行程规划师（travel-planner）

> [English](README.en.md)

**先核验真实世界，再排行程。** 输入目的地/时间/预算/偏好 → 用高德实时事实（POI、营业时间、闭馆日、真实通勤）约束生成 → 输出结构化行程 → **可复算的行程可执行性核验（Trip Check）** → 机械修复 → 持久分享 → 出行当天「行中模式」。

- 在线演示：<https://travel-planner-demo.onrender.com>（Render 免费实例，可能休眠 30–60s；演示行程只读、可克隆）
- 公开核验台：<https://travel-planner-demo.onrender.com/verify>（贴任意 AI 行程 JSON 或分享链接）
- 状态：v9（2026-10-28，Trip Check 核验层 + 确定性修复 + 可分享报告工件），完整演进见 [CHANGELOG.md](CHANGELOG.md)

## 它解决什么问题

大模型能写行程，但不知道「苏州博物馆周一闭馆」「两站之间要走 22 分钟」。平台也不会为行程的可行性背书。
这里做的不是又一份 AI 行程，而是：

1. **生成前拿到事实**：先检索真实 POI/营业时间/闭馆日，注入 prompt，让模型在真实世界上排程，而不是事后抓错；
2. **判定可复算**：两轴报告（结构自洽性 A–D/分数 · 事实核验 verified/partial/unverified），每条问题带规则 ID 与证据；
3. **证据可对账**：同一输入 + 同一引擎/规则版本 → 同一凭据 ID（sha256），任何人可独立复算；
4. **修复有边界**：只在「机械可修」的范围改（顺延时间、删同天重复），修不了如实列出，绝不编造事实、不擅自改写；
5. **行程可执行**：分享页/工作台/行中模式都建立在同一份持久化行程上，闭馆、绕路、时间接不上在出发前暴露。

## 核心能力

| 能力         | 说明                                                                                                                   | 入口                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 事实先行生成 | 高德候选清单 → prompt → 结构化行程；检索失败/境外无覆盖时降级，绝不编造候选                                            | `/new`                                               |
| 行程体检     | 规则级两轴报告；POI 三态 hit/miss/error，营业时间拿不准就 `unknown` 不告警                                             | 工作台第五镜头 `/w/<id>?view=check`                  |
| 开放核验 API | `POST /api/verify` / `/api/verify/schema` / `/api/verify/repair` / `GET /api/verify/openapi`；CORS、限流、无状态不落库 | `/verify` 或直接调 API                               |
| 确定性修复   | 只顺延时间/删同天重复，签发修复前后凭据；预览 → 确认写入（revision+1，乐观并发）                                       | 工作台体检镜头                                       |
| 可分享证据   | 公开报告页 `/p/<id>/check`、竖版海报、纯文本报告；凭据链可追溯                                                         | 分享页/工作台                                        |
| MCP          | `POST /api/mcp` + `npm run mcp`（verify / repair / verify_shared_trip / schema / rules）                               | [mcp/README.md](mcp/README.md)                       |
| 行程工作台   | 规划 / 地图 / 调整 / 今日 / 体检五镜头；拖拽重排、一键顺延、行程管家                                                   | `/w/<id>`                                            |
| 分享与行中   | 海报级分享页 + JSON-LD；行中模式只显示今天，支持天气重排与「今日体检」                                                 | `/p/<id>` · `/t/<id>`                                |
| 度量闭环     | 事件埋点（隐私口径：不含手机号/IP/行程内容）+ 只读看板                                                                 | `POST /api/events`，`GET /api/events/summary?token=` |

**诚实边界**：凭据是可复算哈希，**不是数字签名**；「未核验」永远不等于「没问题」；MOCK 模式不冒充真实核验；
高德数据按协议不建事实库（商用前需确认数据许可，见 [NEXT_STEPS.md](NEXT_STEPS.md)）。

## 技术栈与结构

Next.js 16（App Router）· React 19 · TypeScript strict · Prisma 7（memory/postgres 双存储）· zod 4 · Vitest + 自研 e2e 编排。

```
app/
  (app)/         产品路由：我的行程 / 新建 / 工作台 / 分享 / 行中 / 旅程报告
  (marketing)/   官网：/about /verify /privacy /terms /cities
  api/           生成任务、状态轮询、改行程、核验 API、MCP、地图/天气代理、埋点
lib/
  planner.ts     两条生成路径（≤4 天单次 / ≥5 天分日流式）
  validate.ts    幻觉治理 + 体检（时间轴/节奏/预算/区域/未验真）
  verify/        Trip Check：引擎/规则/凭据/修复/适配/OpenAPI/MCP
  amap.ts        POI 验真 + 通勤（三态 hit/miss/error）
  store/         存储抽象：Job / Plan / Quota / Code（memory / postgres）
components/      工作台、PlanView、行中视图、体检报告、分享动作等
app/styles/      前端设计系统 ATLAS v6（token/原子/分片覆盖层；v5.1 的 globals.css 保留未动）
docs/            标准、ADR、路线、设计语言；索引见 docs/README.md
scripts/         验收：gate / e2e / smoke-deployed / visual-check / demo / preflight
```

**前端设计系统（ATLAS v6「活地图」）**：双主题（Daylight 冷瓷 / Nocturne 深空，跟随系统 +
手动切换）、`--at-*` token 契约、玻璃 + 极光 + 噪点材质、React 19.3 `<ViewTransition>`
路由与镜头转场、CSS scroll-driven 进度线——全部渐进增强、零新增依赖。
规则与取舍见 [docs/design/ATLAS-V6.md](docs/design/ATLAS-V6.md)（含趋势依据与关键来源链接）。

## 快速开始

```bash
cp .env.example .env   # LLM_* 需填；不配高德 key 则以 MOCK 模式跑通全链路
npm install
npx prisma generate    # Prisma 7 起必需（无 postinstall）
npm run dev            # http://localhost:3000
```

拿到高德 key 后先跑 `npm run verify:amap`（5 秒验收 POI/通勤）；生产配置逐项说明见 [DEPLOY.md](DEPLOY.md)。

## 测试与验收

```bash
npm run gate          # 一键验收：typecheck + lint + format + 单测 + e2e（提交前必须全绿）
npm run test:unit     # Vitest 单测
npm test              # e2e：自起桩 LLM + 桩高德 + 隔离服务器
npm run gate:visual   # 视觉/可访问性回归（15 页 × 桌面/手机）
npm run check:env     # 环境变量体检（.env.example 漂移 / 生产安全）
```

当前基线（2026-10-28）：**1202 条单测 + 776 条 e2e 断言**，`npm run gate` 全绿；真实高德 key 3 城评测
（北京/上海/广州）3/3 成功、POI 验真 100%（51/51）、预算贴合中位 82%。数字以 `npm run gate` 实测为准。

部署验收：push 后 Render 自动部署，等 `/api/health` 的 `commit` 变为新提交，再跑
`node scripts/smoke-deployed.mjs <URL>`（含 Trip Check、修复链、生成、分享工件、安全探针）。

## 部署形态

| 形态                   | 适用     | 说明                                                                                           |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| [DEMO.md](DEMO.md)     | 公开演示 | Render 免费 Web Service + 预生成行程 fixture；memory 存储、会休眠、非生产                      |
| [DEPLOY.md](DEPLOY.md) | 正式生产 | `DATA_STORE=postgres` + 登录厂商 + 监控 + 域名；`preflight` / `check:env` 会拦截不安全生产配置 |

## 文档索引

完整索引与阅读顺序见 [docs/README.md](docs/README.md)。常读：

- 标准：[docs/TRIP-CHECK-STANDARD.md](docs/TRIP-CHECK-STANDARD.md)（v0.1 开放标准）
- 策略：[docs/PRODUCT-REVOLUTION-2026-10.md](docs/PRODUCT-REVOLUTION-2026-10.md)（当前阶段）
- 行动：[NEXT_STEPS.md](NEXT_STEPS.md)（上线剩余项与已拍板决策）
- 架构决策：[docs/adr/](docs/adr/)（001–016）
- 安全：[SECURITY.md](SECURITY.md) · [审计报告](docs/SECURITY-AUDIT-2026-10-28.md) · [ADR-016](docs/adr/016-security-hardening-baseline.md)
- API：[API.md](API.md) · 演进：[CHANGELOG.md](CHANGELOG.md)（历史阶段归档在 [docs/archive/](docs/archive/)）

## 已知边界（有意为之）

- 推理模型做约束规划慢（≤4 天 3–4 分钟；≥5 天分日流式），异步任务 + 进度 + 配额退还兜住体验；
- 通勤为驾车距离矩阵估算，不是真实公交/地铁路线；地图只画顺序连线，不冒充导航路径；
- 分享 token 即能力（未上账号体系前，拿到链接即可只读/共编）；演示行程只读、可克隆；
- 修复只做机械变更；「拆天/删点」这类取舍型修复留给用户，不默认自动化；
- 凭据非签名、不构成对真实世界的背书；高德数据存储许可以 [NEXT_STEPS.md](NEXT_STEPS.md) 的决策为准。

## 许可与贡献

[Apache-2.0](LICENSE)（Copyright © 2026 1z5）· 第三方清单 [NOTICE.md](NOTICE.md) · 贡献指南 [CONTRIBUTING.md](CONTRIBUTING.md)。
安全漏洞请走私密渠道（[SECURITY.md](SECURITY.md)），不要公开 issue。
