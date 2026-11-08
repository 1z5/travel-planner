# 架构总览

> 面向读代码的开发者。项目已放弃商业化，本文只描述**工程结构**，不讨论产品定位。
> 状态与数字以源码、`npm run gate` 实测为准；本文不写死测试条数。

## 1. 系统轮廓

一个 Next.js 16 App Router 应用，外部依赖只有三个可替换点：LLM（OpenAI 兼容接口）、
高德 Web API、PostgreSQL（演示环境可退化为进程内 memory）。

```
浏览器
  ├─ 表单 → POST /api/plan ─────────→ 异步 Job（jobs.ts）→ LLM / 高德 → Plan 落库
  ├─ 粘贴任意行程 → /api/verify/extract → 结构化摊开确认 → /api/verify → 修复 → 凭据
  └─ /p /w /t /r /check 报告、海报、ICS ──→ resolvePlan() ──→ PlanStore（含静态 fixture 兜底）
```

三条链路共用同一份 `Plan` 类型与同一个读入口；写端点一律经过 body 上限、同源校验、
demo 只读拦截、配额与 revision 检查（见 §6）。

## 2. 模块地图

| 分组           | 关键文件                                                                                                                                                              | 职责                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 生成链路       | `lib/planner.ts`、`lib/jobs.ts`、`lib/grounding.ts`、`lib/fast-draft.ts`、`lib/draft-plan.ts`、`lib/validate.ts`、`lib/refine.ts`、`lib/replan.ts`                    | ≤4 天单次生成、≥5 天分日流式、事实清单注入、幻觉治理与逐日校验                               |
| 确定性验真     | `lib/verify/engine.ts`、`rules.ts`（16 条 TC-C/TC-F 规则）、`credential.ts`、`repair.ts`、`adapt.ts`、`validate.ts`、`schema.ts`、`openapi.ts`、`mcp.ts`、`jsonld.ts` | 两轴报告、可复算 SHA-256 凭据、机械修复与前后凭据链、开放标准与机器可消费接口                |
| 存储           | `lib/store/{index,memory,postgres,types}.ts`、`lib/plan-repo.ts`、`lib/plan-restore.ts`、`prisma/schema.prisma`                                                       | 统一 Store 接口双实现；`resolvePlan()` 是唯一读入口，附带静态 fixture 与旧 job 链接兜底      |
| 外部数据与合规 | `lib/amap.ts`、`staticmap.ts`、`weather.ts`、`poi-hours.ts`                                                                                                           | POI 三态查询、营业时间、通勤估算、天气；按协议不落库事实数据                                 |
| 认证与配额     | `lib/auth/*`、`lib/ratelimit.ts`、`lib/capacity-gate.ts`、`lib/metrics.ts`、`lib/http-body.ts`、`lib/http-origin.ts`、`lib/client-ip.ts`                              | 三种登录、IP/用户配额、成本闸门、读体与同源保护、只读埋点                                    |
| 行中与报告     | `lib/trip-day.ts`、`trip-execution.ts`、`trip-report.ts`、`trip-document-extract.ts`、`schedule.ts`、`budget.ts`、`packing.ts`、`ics.ts`、`poster-model.ts`           | 行中当日视图、确定性重排、旅程报告、日历订阅、海报、任意来源文本抽取                         |
| 前端           | `app/(app)/`、`app/(marketing)/`、`components/`、`app/styles/`                                                                                                        | 产品路由 / 营销路由分组；工作台五镜头、PlanView、体检报告、行中视图；ATLAS v6 覆盖层设计系统 |

`app/api/` 共 33 条路由：生成 13、验真开放 API 6、认证 6、外部代理 5、事件与健康 3。

## 3. 三条核心数据流

**① 生成（长任务）**
`app/home-client.tsx` POST `/api/plan` → `app/api/plan/route.ts` 校验 body / 配额 →
`lib/jobs.ts::createJob` 返回 `202 {jobId}` → 后台 IIFE：<5 天走快速草稿 + `generatePlan` +
`validatePlan` + 天气；≥5 天走 `runStreaming`（大纲 → 并发 3 路逐日生成 → `validateDay` →
前缀发布 → `finalizePlan`），带心跳与 stage 遥测 → `plan-repo.ts::commitPlan` 落库并生成 shareId →
前端轮询 `/api/plan/status` → 跳 `/p/<shareId>`。

**② 验真（确定性链路）**
`/check` → `POST /api/verify/extract`（`lib/trip-document-extract.ts`，模型输出只作素材，
文档由服务端按白名单**重新构造**，核验/坐标/路段一律不填，没写时间填「未标注」触发 TC-C101）→
`TripCheckDesk` 把结果先摊开给人确认 → `POST /api/verify`（`verifyDocument` + `credentialOf`）→
`POST /api/verify/repair`（纯确定性修复 + 前后两张凭据）→ `TripCheckReport` 呈现。
关键点：**判定与修复都不调模型**，同一输入 + 同一版本必得同一凭据 ID。

**③ 读取与复用**
`plan-repo.ts::resolvePlan` 统一被 `/p`（分享）、`/w`（工作台）、`/t`（行中）、`/r`（报告）、
`/p/<id>/check`（公开报告）、OG 图、海报、`/api/plan/ics`（日历订阅）调用。
优先级：`PlanStore` → 静态 demo fixture（带 `demo:true` 只读标记）→ 旧 job 链接兜底（可用
`JOB_LINK_FALLBACK=0` 关闭）。静态 fixture 让示例链接不依赖 `DEMO_SEED`、不受重启影响。

## 4. 存储

`store/index.ts::getStore()` 按 `DATA_STORE` 选择：默认 memory（`globalThis Map`，Plan TTL 30 天，
事件上限 5000），`postgres` 走 PrismaClient 懒实例化。Schema 只有 5 个 model：
`Job` / `Plan` / `QuotaBucket` / `SmsCode` / `TripEvent`。

演示部署（`render.yaml`）刻意不设 `DATA_STORE`（=memory）+ `DEMO_SEED=1` + `JOB_LINK_FALLBACK=0`，
因此**免费实例重启会丢数据**，分享链接只保证静态 fixture 可读。真要持久化须设
`DATA_STORE=postgres` 并跑迁移。

## 5. 测试与门禁

| 层       | 实现                                                                            | 说明                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单测     | `vitest.config.mts`、`tests/`                                                   | jsdom、globals、`@` 别名、`server-only` 空桩、v8 coverage（行/函数/语句 50%，分支 40%）                                                                                                        |
| e2e      | `scripts/run-tests.mjs` + `scripts/e2e-slices/`                                 | 自起 4 个桩（LLM / 高德 / 微信 / 短信，动态端口）、最多 7 台隔离 dev server（固定端口 3103–3109，各自 `NEXT_DIST_DIR=.next-t-*`）、`.e2e-lock` 文件锁；8 个切片在 mock / real 两种模式各跑一遍 |
| CI       | `.github/workflows/ci.yml`                                                      | `test`（audit → lint → format → typecheck → build → e2e → coverage）、`secret-scan`（gitleaks）、`test-postgres`（postgres:16 service 跑 phaseP）                                              |
| 本地钩子 | `.husky/pre-commit` → lint-staged；`.husky/pre-push` → typecheck + format:check | pre-push 刻意不跑全量 lint；`npm run gate` 才是完整链路                                                                                                                                        |

`npm run gate` = typecheck → lint → format:check → test:unit → npm test。
**测试条数不写进文档**：历史上 README / CHANGELOG / 路线图三处数字互相矛盾，现统一以命令输出为准。

> 环境提示：连续跑 e2e 后 `.next-t-*` 会累积到 1GB+，Turbopack 清理时可能触发沙箱的批量删除保护，
> 表现为随机一台测试服务器起不来；清掉这 6 个目录即可。删除页面后若残留
> `.next-t-*/dev/types/validator.ts`，`tsc --noEmit` 会报指向已删除路由的 TS2307，同样清缓存解决。

## 6. 配置与安全边界

- `next.config.ts`：`output: standalone`、`distDir` 可由 `NEXT_DIST_DIR` 覆盖、CSP / COOP / CORP /
  HSTS（仅 https）、`/p|t|w|r` 加 `X-Robots-Tag: noindex`、`poweredByHeader: false`。
- `tsconfig.json`：strict、noEmit、`moduleResolution: bundler`、`isolatedModules`。
- 写端点统一用 `lib/http-body.ts::readJsonBody`（16–32 KiB 上限）与
  `lib/http-origin.ts::crossSiteWriteError`；demo 行程只读；不信任客户端回传的
  `verified` / `verification` / `tripCheck` 受信字段。
- 声明边界见 [SECURITY.md](../SECURITY.md) 与 [ADR-016](adr/016-security-hardening-baseline.md)：
  分享 token 即能力、开放核验接口无鉴权仅靠限流、凭据非签名、CSP 仍含 `unsafe-inline`、
  演示站 memory + 重启丢数据、无错误监控。

## 7. 已知技术债

诚实列出，不假装仓库是干净的。每条都能在源码里核到：

| 项                                       | 证据                                                                            | 现状                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| TypeScript 7 超出 typescript-eslint 支持 | `package.json` / `eslint.config.js:2`                                           | 类型感知 lint 全缺，TS/TSX 由 oxlint 兜底；lint 分两段           |
| 60 条存量 lint warning                   | `npm run lint` 实测 0 error / 60 warning                                        | 多为 `react/set-state-in-effect` 等历史代码；新增代码要求 0 告警 |
| CSS 覆盖层「后写者胜」                   | `app/layout.tsx` import 顺序；`app/globals.css` 10150 行 + `atlas-*.css` 分片   | `globals.css` 冻结不动，新样式只能追加独立命名空间分片           |
| e2e 编排单文件 3272 行                   | `scripts/run-tests.mjs`                                                         | 切片已外置到 `e2e-slices/`，主文件仍是编排 + 全阶段断言          |
| 环境变量无统一 config 层                 | `scripts/check-env.mjs` 自述、全仓 80+ 处 `process.env` 裸读                    | 拼错的症状是静默降级                                             |
| 门禁口径分裂                             | `preflight.mjs` 无条件 BLOCK；`check-env.mjs` 仅 `NODE_ENV=production` 才 BLOCK | `render.yaml` 的 buildCommand 不跑 preflight                     |
| memory store / 配额按实例计数            | `store/memory.ts`、`capacity-gate.ts:13-15`                                     | 多副本会失真，重启丢数据                                         |
| ADR 索引曾落后                           | `docs/adr/README.md`                                                            | 已补齐 001–016                                                   |
| Node 版本口径                            | `package.json` engines `>=22` / `.nvmrc` 22，`preflight.mjs` 按 `>=20` 检查     | 未统一                                                           |

## 8. 设计取舍速查

16 篇 ADR 见 [adr/](adr/)。最常被问到的几条：异步任务（001）、POI 三态（002）、
Plan 一等聚合（003）、分日流式（004）、确定性修复 vs LLM（005）、事实先行（006）、
开放核验标准与凭据（012）、前后凭据链（013）、安全加固基线（016）。
按仓库约定 **ADR 不删不改结论**，新决策只追加新 ADR。
