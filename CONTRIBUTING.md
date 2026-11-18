# 贡献指南

从[本地运行步骤](README.md#在本地运行)开始。改动前检查工作区和相关调用方，保留已有工作。代码约定与验收命令见 [AGENTS.md](AGENTS.md)。

- 提交前运行 `npm run gate`。界面改动用 `npm run gate:visual` 和 `npm run gate:visual -- --theme dark` 检查桌面与移动端。
- 新功能覆盖关键边界和失败路径。接口行为变化更新 [API 文档](docs/API.md)，面向使用者的变化记录在 [CHANGELOG.md](CHANGELOG.md)。
- 使用 Conventional Commits，如 `fix(plan): preserve stop identifiers after reordering`。PR 说明影响范围和实际验证结果。
- 依赖 PR 需 CI 通过。主版本更新单独验收。密钥、私人行程和本机配置放在 Git 跟踪范围之外。

[文档索引](docs/README.md) · [安全漏洞报告](SECURITY.md)
