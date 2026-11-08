# travel-planner — 用真实世界约束 LLM 的全栈技术样例

> [English](README.en.md) · [架构总览](docs/ARCHITECTURE.md) · [在线演示](https://travel-planner-demo.onrender.com)

> **项目定位（2026-11-08 起）**：个人开源**技术展示**项目，已放弃商业化。
> 不提供商业服务、不承诺可用性、不收集真实用户数据；在线演示是 Render 免费实例，会休眠、重启丢数据。
> 2026-10 ~ 11 的产品 / 获客策略文档已归档到 [docs/archive/strategy/](docs/archive/strategy/)，
> 只作决策脉络，不代表当前计划。

一个跑得通的 Next.js 全栈样例：把「LLM 生成行程」做成**事实约束 → 确定性判定 → 可复算证据**的完整工程链路。
它不追求产品化，追求的是每一层都写清楚、测到、能自己跑起来。

## 这个项目展示什么

| 主题       | 具体做法                                                                                                  | 从哪看                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 长任务编排 | 2–4 分钟的推理做成异步 Job + 心跳自愈；≥5 天走「大纲 → 并发 3 路分日生成 → 逐日校验 → 前缀发布」          | `lib/jobs.ts` · `lib/planner.ts` · [ADR-001](docs/adr/001-async-jobs.md) · [ADR-004](docs/adr/004-streaming-multi-day.md)       |
| 确定性判定 | 16 条纯函数规则 + 两轴报告，判定不调模型；同一输入 + 同一引擎/规则版本 → 同一凭据 ID，第三方可独立复算    | `lib/verify/*` · [开放标准](docs/TRIP-CHECK-STANDARD.md)                                                                        |
| 幻觉治理   | 生成前注入高德事实；POI 三态 `hit/miss/error`；没查过就写 `unverified`，不猜、不伪造核验状态              | `lib/grounding.ts` · `lib/amap.ts` · [ADR-002](docs/adr/002-poi-three-state.md) · [ADR-006](docs/adr/006-ground-truth-first.md) |
| 可撤销修复 | 只做机械修复（顺延时间 / 删同天重复），预览 → 确认写入，`revision+1` 乐观并发，签发前后凭据链             | `lib/verify/repair.ts` · [ADR-005](docs/adr/005-deterministic-fix.md) · [ADR-013](docs/adr/013-trip-check-repair.md)            |
| 存储抽象   | 同一 Store 接口的 memory / postgres 双实现，静态 fixture 兜底，统一读入口 `resolvePlan`                   | `lib/store/` · `lib/plan-repo.ts` · `prisma/schema.prisma`                                                                      |
| 契约化工程 | 33 条 API 路由、单测 + 自建 e2e 编排（4 个桩 / 隔离端口 / 文件锁）、CI 三 job、pre-commit / pre-push 钩子 | [架构总览](docs/ARCHITECTURE.md) · [贡献指南](CONTRIBUTING.md)                                                                  |
| 前端       | ATLAS v6 双主题设计系统、React 19 View Transitions、CSS scroll-driven 进度线，零新增依赖                  | `app/styles/` · [设计文档](docs/design/ATLAS-V6.md)                                                                             |

串起来看：**任意来源的行程文本 → 结构化摊开确认 → 确定性体检 → 一键理顺 → 可复算凭据**；
或从表单生成一份带事实约束的行程，再看它在分享页 / 工作台 / 行中模式里怎么被复用。

## 技术栈

Next.js 16（App Router）· React 19 · TypeScript 7 strict · Prisma 7 + PostgreSQL（可切 memory）·
zod 4 · Vitest + 自研 e2e 编排 · 高德开放平台 Web API（可选，无 key 时走 MOCK）。

## 快速开始

```bash
cp .env.example .env   # 不配 key 也能跑通 MOCK 全链路；LLM_* 需填才能真生成
npm install
npx prisma generate    # Prisma 7 起必须手动执行
npm run dev            # http://localhost:3000
```

打开 `/` 或 `/check`。想秒开一份完整成品（不调 LLM、不用 key）点首页「看一份验真过的成品」。
拿到高德 key 后可用 `npm run verify:amap` 做 5 秒的 POI / 通勤验收。

## 测试与门禁

```bash
npm run gate          # 一键验收：typecheck + lint + format + 单测 + e2e
npm run test:unit     # Vitest 单测
npm test              # e2e：自起 4 个桩 + 隔离 dev server，不需要外部服务
npm run gate:visual   # 视觉 / 可访问性回归
npm run check:env     # 环境变量体检
```

**文档不写死测试条数**：以 `npm run gate` 实测为准，CI 每次 push 会跑完整链路。
当前 `lint` 为 0 error / 60 条存量 warning，成因与明细见 [架构总览 · 已知技术债](docs/ARCHITECTURE.md#已知技术债)。

## 目录导览

```
app/
  (app)/         产品路由：首页 / 新建 / 验真台 / 工作台 / 分享 / 行中 / 报告
  (marketing)/   关于 / 城市模板 / 隐私 / 条款 / 开放核验体验台
  api/           33 条路由：生成任务、验真开放 API、认证、地图天气代理、埋点
  styles/        ATLAS v6 设计系统分片（globals.css 冻结，覆盖层后写者胜）
lib/
  planner/jobs/validate/grounding   生成链路
  verify/       Trip Check：引擎 / 规则 / 凭据 / 修复 / OpenAPI / MCP / JSON Schema
  store/        memory + postgres 双实现
  amap/weather/staticmap            外部数据与合规
  auth/ratelimit/capacity-gate      认证与配额
components/      工作台、PlanView、行中视图、体检报告、分享动作
prisma/          5 个 model：Job / Plan / QuotaBucket / SmsCode / TripEvent
tests/           Vitest 单测
scripts/         e2e 编排、8 个切片、桩服务、部署与验收脚本
docs/            架构总览、开放标准、16 篇 ADR、设计系统、安全审计、历史归档
```

## 文档

- [架构总览](docs/ARCHITECTURE.md) — 模块地图、三条数据流、测试与门禁、已知技术债
- [文档索引](docs/README.md) — 现行 / 归档 / 部署 / 开源标配
- [Trip Check 开放标准 v0.1](docs/TRIP-CHECK-STANDARD.md) · [API 契约](API.md) · [ADR 001–016](docs/adr/)
- [安全边界](SECURITY.md) · [安全审计](docs/SECURITY-AUDIT-2026-10-28.md) · [变更历史](CHANGELOG.md)
- [演示部署](DEMO.md) · [生产部署参考](DEPLOY.md)（保留作工程样例，不代表本项目要上线）

## 已知边界（有意为之）

- 凭据是可复算哈希，**不是数字签名**，不构成对真实世界的背书；`unverified` 不等于「没问题」。
- 高德数据按协议不建事实库；本项目不用于商业用途，也不主张任何数据许可。
- 演示站 memory 存储、重启丢数据；分享 token 即能力（未做账号体系）；配额按实例内存计数。
- 通勤是驾车距离矩阵估算，不是真实公交 / 地铁路线；地图只画顺序连线，不冒充导航。
- 生成慢（≤4 天 3–4 分钟，≥5 天分日流式），靠异步任务 + 进度 + 配额退还兜住体验。
- 没有错误监控，失败只落 console；这不是生产级可观测性。

## 许可与贡献

[Apache-2.0](LICENSE)（Copyright © 2026 1z5）· 第三方声明 [NOTICE.md](NOTICE.md) ·
[贡献指南](CONTRIBUTING.md) · 安全漏洞请走 [SECURITY.md](SECURITY.md) 的私密渠道。

这是个人技术展示项目，欢迎 issue / 讨论，但**不保证接受 PR，也不提供维护承诺**。
