# 架构决策记录（ADR）

记录重要的架构决策及其原因。格式：`NNNN-title.md`。
按[文档索引](../README.md)约定：**ADR 不删不改结论**，新决策追加新 ADR，只有笔误与链接可以修。

## 索引

| ADR                                              | 标题                           | 状态   |
| ------------------------------------------------ | ------------------------------ | ------ |
| [001](001-async-jobs.md)                         | 异步任务架构                   | 已接受 |
| [002](002-poi-three-state.md)                    | POI 查询三态原则               | 已接受 |
| [003](003-plan-persistence.md)                   | Plan 持久化为一等聚合          | 已接受 |
| [004](004-streaming-multi-day.md)                | ≥5 天分日流式生成              | 已接受 |
| [005](005-deterministic-fix.md)                  | 确定性修复 vs LLM 修复         | 已接受 |
| [006](006-ground-truth-first.md)                 | 事实先行（生成前给事实）       | 已接受 |
| [007](007-paper-itinerary-design.md)             | 纸上行程（浅色编辑风）         | 已接受 |
| [008](008-enterprise-precision.md)               | 企业级精度（可信产品）         | 已接受 |
| [009](009-multi-city-itinerary.md)               | 跨城/多城市行程                | 已接受 |
| [010](010-frugal-budget.md)                      | 预算下限 0（穷游模式）         | 已接受 |
| [011](011-trip-workspace-and-product-surface.md) | Trip Workspace 与产品/营销分域 | 已接受 |
| [012](012-trip-check-open-verification.md)       | 把核验做成开放标准与凭据       | 已接受 |
| [013](013-trip-check-repair.md)                  | 确定性修复 + 前后凭据链        | 已接受 |
| [014](014-trip-check-in-product.md)              | 核验进产品主流程               | 已接受 |
| [015](015-shareable-trip-check-report.md)        | 可分享的体检报告               | 已接受 |
| [016](016-security-hardening-baseline.md)        | 安全加固基线                   | 已接受 |

> 012–015 里引用的产品策略文档已归档到 [../archive/strategy/](../archive/strategy/)，
> 链接已更新，但 ADR 的结论与上下文保持原样（历史记录）。
