# 文档索引

> 仓库文档的**唯一入口**。AI 代理开工前先读本页 + [AGENTS.md](../AGENTS.md)。
> 项目已放弃商业化，定位为个人开源技术展示项目；状态与数字以源码、`npm run gate` 实测为准。

## 阅读顺序

1. [README.md](../README.md) — 项目定位、技术栈、怎么跑、已知边界
2. [ARCHITECTURE.md](ARCHITECTURE.md) — **读代码前先看**：模块地图、三条数据流、测试与门禁、已知技术债
3. [AGENTS.md](../AGENTS.md) — 开发协议、红线、验收流程（AI 必读）
4. [TRIP-CHECK-STANDARD.md](TRIP-CHECK-STANDARD.md) — 开放标准 v0.1（文档格式 / 规则 / 凭据 / 三态）
5. [adr/](adr/) — 16 篇架构决策记录，改架构前先查历史
6. [design/ATLAS-V6.md](design/ATLAS-V6.md) — 改任何 UI 前先读（token / 材质 / 动效 / 分片规则）
7. [API.md](API.md) — HTTP 接口契约；[CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献与提交规范
8. [SECURITY.md](../SECURITY.md) + [SECURITY-AUDIT-2026-10-28.md](SECURITY-AUDIT-2026-10-28.md) — 安全基线与审计

## 现行技术文档

| 文档                                                         | 作用                                                |
| ------------------------------------------------------------ | --------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)                           | 架构总览：模块地图 / 数据流 / 测试门禁 / 已知技术债 |
| [TRIP-CHECK-STANDARD.md](TRIP-CHECK-STANDARD.md)             | 核验层开放标准 v0.1                                 |
| [design/ATLAS-V6.md](design/ATLAS-V6.md)                     | 前端设计系统与「不要做」清单（§0 / §6）             |
| [SECURITY-AUDIT-2026-10-28.md](SECURITY-AUDIT-2026-10-28.md) | 只读安全审计、修复状态与未闭环项                    |
| [adr/](adr/)                                                 | 架构决策记录 001–016，含替代方案与取舍              |
| [API.md](API.md) / [../CHANGELOG.md](../CHANGELOG.md)        | 接口契约 / 逐轮变更与踩坑记录                       |
| [../mcp/README.md](../mcp/README.md)                         | MCP 服务说明                                        |

## 部署与运维（工程参考）

| 文档                               | 适用                                                          |
| ---------------------------------- | ------------------------------------------------------------- |
| [DEMO.md](DEMO.md)                 | 公开演示：Render 免费实例 + 静态 fixture，memory 存储、会休眠 |
| [DEPLOY.md](DEPLOY.md)             | 生产配置参考（Postgres / 登录 / 监控 / 域名）                 |
| [../.env.example](../.env.example) | 环境变量分组与说明                                            |

> 本项目不计划商业上线；这两份文档保留作工程样例，不代表当前排期。

## 开源标配

[../CONTRIBUTING.md](../CONTRIBUTING.md) · [../SECURITY.md](../SECURITY.md) ·
[../NOTICE.md](../NOTICE.md) · [../LICENSE](../LICENSE) · [../README.en.md](../README.en.md)

## 归档（仅追溯，不作为依据）

- [archive/strategy/](archive/strategy/) — 2026-10 ~ 11 的产品 / 获客 / 商业化策略：
  `PRODUCT-REVOLUTION-2026-10.md`、`NEXT_STEPS.md`、`PHASE0-ACQUISITION-PLAYBOOK.md`
- [archive/](archive/) — 更早的北极星与产品升级蓝图

归档文件顶部都带说明 banner。当时的数字、路线图、付费设想均已作废，读它们只为理解
「为什么代码长这样」。

## 维护约定

- **数字不手写死**：测试条数、版本状态以 `npm run gate` / `/api/health` / 最新提交为准。
- **被取代的文档**移入 `archive/` 并加归档 banner，不要留着和现行文档打架。
- **ADR 不删不改结论**：新决策追加新 ADR；只有笔误与链接可以修。
- **公开叙事**：仓库公开，文档 / 提交信息使用中性项目口径；不写本地绝对路径、
  不写占位联系方式（用 GitHub 私密渠道）。
- **新样式**：`app/globals.css` 冻结，只在 `app/styles/` 追加独立命名空间分片。
