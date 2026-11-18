<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 仓库开发约定

开工先确认目标、工作区状态、调用方和验证方式。保留用户已有改动。可用任务板时先认领写入范围，完成后记录差异与验收。涉及多进程或共享状态的操作按依赖顺序执行。

- 仓库入口见 [文档索引](docs/README.md)，领域模块见 [架构](docs/ARCHITECTURE.md)。改 UI 前读 [ATLAS 前端设计](docs/design/ATLAS-V6.md)。
- 优先复用领域逻辑。POI 区分命中、查无结果和上游异常，缺少事实就展示未知。体检只提示，调整由用户触发。
- 新增或修改 API 用 `readJsonBody` 读 JSON，状态变更经 `crossSiteWriteError` 校验。演示行程只读，服务端重建客户端传入的核验数据。行中私人记录需要登录与所有者校验。
- 保持服务端和客户端边界。操作密钥的模块使用 `server-only`，复用现有客户端安全纯函数。项目的 Next.js 路由参数按 Promise 读取。
- `app/globals.css` 保持冻结。在归属的 `app/styles/` 分片内修改或删除样式。`atlas-companion.css` 最后加载。
- 提示词集中在 `lib/prompts/`，版本与测试一并维护。桩模型只从「目的地 / 出行偏好」读取测试开关词。
- 新功能覆盖边界和故障路径。接口变化更新 [API.md](docs/API.md)，用户可感知的变化记录到 [CHANGELOG.md](CHANGELOG.md)。注释解释设计原因或边界。
- 避免在公开文案写死测试条数、特定模型或缺少证据的保证。敏感配置、本机路径和私人行程留在工作区的非跟踪文件。

## 验证与交付

- 提交前跑 `npm run gate`。当前 lint 由 ESLint 检 JS，oxlint 检 TS/TSX。依赖主版本单独验收，PR 须 CI 通过。
- UI 另跑浅色、深色两套 `gate:visual`。视觉脚本用 CDP 设置手机视口，按改动维护关键元素和对比度选择器。
- Prisma 7 需显式生成 Client，改 schema 时同步迁移。部署步骤见 [部署指南](docs/DEPLOY.md)。
- Push 到 `main` 后，等 Render 的 `/api/health` 返回对应 commit，再跑 `npm run smoke -- https://travel-planner-demo.onrender.com`。冒烟包含一次生成。
- e2e 使用固定端口与文件锁，使用隔离构建目录。运行前先确认监听进程归属，不中断他人的服务。提交只 add 自己修改的文件，使用 Conventional Commits。
