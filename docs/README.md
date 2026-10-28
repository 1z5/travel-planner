# 文档索引（docs/README.md）

> 这是仓库文档的**唯一入口**。AI 代理开工前先读本页 + [AGENTS.md](../AGENTS.md)；
> 状态和数字以 `npm run gate` / `/api/health` / 最新提交为准，文档只做导航与解释。

## 当前状态（2026-10-28）

- **阶段**：v9「行程可执行性核验层」（Trip Check 开放标准 v0.1 + 两轴报告 + 可复算凭据 +
  确定性修复 + 工作台/分享页/行中接入 + 可分享报告工件 + 安全加固）。
- **演示站**：Render 免费实例（memory 存储、会休眠、演示行程只读）——不是生产环境。
- **生产就绪前置**：Postgres、登录厂商、监控、域名、高德数据许可确认——见 [../NEXT_STEPS.md](../NEXT_STEPS.md)。
- **测试基线**：以 `npm run gate` 实测为准（当前 1202 单测 / 776 e2e 断言）。

## 阅读顺序

1. [../README.md](../README.md) — 产品是什么、怎么跑、边界在哪
2. [../AGENTS.md](../AGENTS.md) — 开发协议、红线、验收与部署流程（AI 必读）
3. [PRODUCT-REVOLUTION-2026-10.md](PRODUCT-REVOLUTION-2026-10.md) — 当前阶段策略与路线
4. [TRIP-CHECK-STANDARD.md](TRIP-CHECK-STANDARD.md) — 开放标准 v0.1（文档格式/规则/凭据/三态/版本）
5. [../NEXT_STEPS.md](../NEXT_STEPS.md) — 上线剩余项与已拍板决策
6. [adr/](adr/) — 架构决策记录（001–016，改架构前先查历史决策）
7. [../SECURITY.md](../SECURITY.md) + [SECURITY-AUDIT-2026-10-28.md](SECURITY-AUDIT-2026-10-28.md) — 安全基线
8. [../API.md](../API.md) — HTTP 接口契约；[../CHANGELOG.md](../CHANGELOG.md) — 演进历史（按时间倒序）

## 文档地图

| 文档                                                              | 作用                        | 什么时候读              |
| ----------------------------------------------------------------- | --------------------------- | ----------------------- |
| [../README.md](../README.md) / [../README.en.md](../README.en.md) | 对外产品说明                | 第一次接触项目          |
| [../AGENTS.md](../AGENTS.md)                                      | AI/协作开发规范与验收门     | 每次开工前              |
| [PRODUCT-REVOLUTION-2026-10.md](PRODUCT-REVOLUTION-2026-10.md)    | 当前策略、证据、路线        | 决定做什么之前          |
| [TRIP-CHECK-STANDARD.md](TRIP-CHECK-STANDARD.md)                  | 核验层开放标准              | 改引擎/规则/凭据/API 前 |
| [../NEXT_STEPS.md](../NEXT_STEPS.md)                              | 上线行动清单 + 已拍板决策   | 规划下一轮              |
| [adr/](adr/)                                                      | 架构决策与替代方案          | 改架构/存储/接口前      |
| [SECURITY-AUDIT-2026-10-28.md](SECURITY-AUDIT-2026-10-28.md)      | 安全审计与修复状态          | 改公开端点/鉴权/限流前  |
| [../API.md](../API.md)                                            | 接口契约（含错误码）        | 改路由/客户端前         |
| [../CHANGELOG.md](../CHANGELOG.md)                                | 逐轮变更与踩坑记录          | 排查「为什么这样写」    |
| [../DEMO.md](../DEMO.md) / [../DEPLOY.md](../DEPLOY.md)           | 演示部署 / 正式部署         | 部署前                  |
| [../mcp/README.md](../mcp/README.md)                              | MCP 服务说明                | 接 MCP 前               |
| [archive/](archive/)                                              | **已归档**的历史路线/北极星 | 仅追溯，不作为排期依据  |

## 维护约定

- **数字不手写死**：测试条数以 `npm run gate` 实测为准，文档只写「当前基线 + 日期」。
- **新增路线图**：先更新 [PRODUCT-REVOLUTION-2026-10.md](PRODUCT-REVOLUTION-2026-10.md)；被取代的文档
  移入 [archive/](archive/) 并加归档 banner，不要留着和当前策略打架。
- **公开叙事**：仓库对外公开，文档/提交信息使用中性项目口径；不写求职语境、本地绝对路径、
  占位联系方式（用 GitHub 私密渠道或真实可收信地址）。
- **ADR 不删不改结论**：新决策追加新 ADR；只有笔误/链接可以修。
