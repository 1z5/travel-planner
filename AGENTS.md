<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AI Agent 操作指南

本文件是给 AI coding agent 看的项目级指令。**修改代码前必读。**

## 项目一句话

AI 行程规划平台：用户输入目的地/时间/预算/偏好 → step-5 生成结构化行程 JSON → 高德 POI 验真 + 营业时间 + 通勤 → 体检预警 → 可修改（换一个/一句话改/一键修复）→ 持久分享 → 行中模式。

## 核心原则（不可违反）

1. **不猜、不假装**：数据缺失就明说「没有」，不用默认值填充。POI 查询三态（hit/miss/error），只有 miss 才告警「未检索到」，error 归为系统提示。
2. **体检而非隐瞒**：所有风险摊开告诉用户，不擅自改写行程。用户主动修改时才改。
3. **诚实降级**：MOCK 模式/无 key/上游故障时优雅降级，不编造假数据。
4. **注释写「为什么」**：用中文解释设计决策和踩坑原因，不写「是什么」。

## 架构速览

```
app/
  page.tsx              首页（服务端外壳 + 客户端表单）
  home-client.tsx       表单 + 轮询 + 结果渲染 + 最近行程
  api/plan/route.ts     POST → 创建异步任务 → 返回 jobId
  api/plan/status/      GET → 轮询任务状态（running/done/error + shareId）
  api/plan/refine/      POST → 换一个/一句话改/一键修复（LLM 改一天）
  api/plan/adjust/      POST → 一键顺延时间轴（确定性重排，不调模型）
  api/plan/chat/        POST → 行程管家（step-5 对话问答 + 修改建议）
  api/map/              GET → 高德静态地图代理
  api/weather/          GET → 天气预报
  p/[id]/               分享页（持久 token）
  t/[id]/               行中模式（出行当天执行视角）

lib/
  planner.ts            两条生成路径：≤4 天单次 / ≥5 天大纲+分日
  jobs.ts               异步任务 + 分日流式 + 心跳/陈旧自愈 + 收尾持久化
  grounding.ts          事实先行：生成前取真实素材清单（POI/营业时间/闭馆日）
  refine.ts             改行程：prompt 构造 / 解析校验 / 硬约束保护 / 重体检
  copilot.ts            行程管家：行程事实摘要 + step-5 问答 + 结构化建议
  validate.ts           幻觉治理 + 体检：绕路/节奏/预算/营业时间/时间轴
  amap.ts               POI 验真（extensions=all）+ 候选检索 + 通勤 + 路段，三态 hit/miss/error
  poi-hours.ts          营业时间文本解析与判定（client-safe）
  schedule.ts           时间轴冲突检测 / 确定性顺延（client-safe）
  fix-actions.ts        体检「一键修复」识别与模板化指令（client-safe）
  budget.ts             预算汇总（最大余数法百分比 / 四态阈值）
  plan-repo.ts          Plan 领域门面：commit/get/replace/resolve
  store/                存储抽象层：Job/Plan/Quota/Code 四类接口
                        memory（默认）/ postgres（Prisma）双实现
  staticmap.ts          静态地图上游（LRU + 串行队列 + 错误语义）
  map-view.ts           Web Mercator 视野拟合/像素投影（client-safe）

components/
  PlanView.tsx          行程展示（结果页/分享页共用）
  PlanCopilot.tsx       行程管家对话面板
  TodayView.tsx         行中模式今日视图
  RealMap.tsx           真实地图（高德底图 + 自绘覆盖层）
  BudgetInsight.tsx     预算透视
```

## 开工前先看这里（当前状态）

- **v5「事实先行」已落地**（提交 `ad502fe`）：生成前用高德真实素材清单（名称/营业时间/闭馆日）约束模型，行程天生可执行。代码与测试全绿（625 单测 + 295 e2e），但**尚未用真实高德 key 验收**——验收清单见 [NEXT_STEPS.md](NEXT_STEPS.md) 的「v5 专项验收清单」。
- **下一轮三条赛道**（旅行档案 / 行中重规划求解器 / 出行准备包）的可执行切片——含要碰的文件、验收标准、最容易踩的坑——见 [docs/PRODUCT-NORTH-STAR.md](docs/PRODUCT-NORTH-STAR.md) 第五节。产品判断与优先级见同文件第一~四节。
- **坑提醒**：桩测试的开关词只能从「目的地 / 出行偏好」两行取（见 `scripts/stub-llm.mjs` 的 `switchSource`），**不能对整条 prompt 做 `includes` 匹配**——prompt 正文里现在有真实营业时间原文（「全天不开放」含「空」），整条匹配会把普通正文误判成测试开关。

## 如何添加新功能

1. **读 CHANGELOG.md** — 了解历史决策和踩坑，避免重复犯错
2. **读相关模块** — 理解现有模式（如三态、异步任务、Store 抽象）
3. **写测试** — 新功能必须有测试；覆盖边界和故障路径，不只是 happy path
4. **改代码** — 遵循现有模式；注释写「为什么」
5. **验证** — `npm run typecheck && npm run lint && npm run test:unit && npm test`
6. **更新文档** — README（如适用）、API.md（如改接口）、CHANGELOG.md
7. **提交** — conventional commits（feat/fix/perf/refactor/docs/test/chore）

## 如何测试

```bash
npm run typecheck      # TypeScript strict
npm run lint           # ESLint（0 error 0 warning）
npm run test:unit      # Vitest 623 条（组件 + 纯逻辑）
npm test               # e2e 295 条（桩 LLM + 桩高德 + 隔离服务器）
npm run test:coverage  # 覆盖率报告
```

e2e 用桩服务（`scripts/stub-llm.mjs` / `scripts/amap-stub.mjs`）模拟 LLM 和高德，不烧真 token、不需要真 key。桩按请求内容切换行为（城市名/关键词），让故障注入测试秒级完成。

## LLM 相关

- **模型**：step-5-preview（OpenAI 兼容，1M context，64000 max tokens）
- **配置**：`.env` 的 `LLM_*` 变量
- **Prompt 管理**：集中在 `lib/prompts/` 目录，每个 prompt 有版本号和单测
- **流式**：`lib/planner.ts` 的 `streamChatRetry` 统一处理连接重试 + 10 分钟总时长兜底
- **行程管家**：`lib/copilot.ts`，只依据行程事实回答，结构化 JSON 输出

## 关键设计决策

详见 [docs/adr/](docs/adr/) 架构决策记录 + [CHANGELOG.md](CHANGELOG.md) 变更日志。

- **异步任务**：step-5 推理 3-5 分钟，同步等待不可行。POST 返回 jobId，前端轮询。
- **分日流式**：≥5 天单次调用必爆 token，拆为大纲 + 逐日生成，多天并发 + 前缀发布保序。
- **Plan 持久化**：行程是一等聚合（share token + revision），Job 是一次性执行记录。
- **三态原则**：POI 查询 hit/miss/error，只有 miss 告警，error 归系统提示。
- **确定性修复**：时间轴顺延不调模型（adjust），LLM 修复用模板化指令（fix）。
- **事实先行**：生成前先用高德取真实素材清单（名称/营业时间/闭馆日）注入 prompt，
  行程天生可执行；拿不到事实就退回旧路径，绝不编造候选。详见 ADR-006。

## 环境变量

参考 `.env.example`。关键变量：

- `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` — step-5 配置
- `AMAP_WEB_SERVICE_KEY` — 高德 key（不填则 MOCK 模式）
- `DATA_STORE` — memory（默认）/ postgres
- `LLM_STREAM_DEADLINE_MS` — 流式总时长兜底（默认 10 分钟）
- `COPILOT_HOURLY_LIMIT` — 行程管家限流（默认 40/h）

## 注意事项

- **Prisma 7**：`@prisma/client` 无 postinstall，改 schema 后必须 `npx prisma generate`
- **Next.js 16**：params/searchParams 都是 Promise，需要 await
- **server-only**：lib 下的服务端模块 import "server-only"，客户端组件不能 import
- **client-safe**：poi-hours/schedule/fix-actions/budget/map-view 是纯函数，客户端可用
- **不要提交 .env**：.gitignore 已排除
