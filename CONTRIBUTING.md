# 贡献指南

感谢参与 travel-planner 的开发。本项目按生产级标准运作，请遵循以下规范。

## 开发环境

```bash
# 要求 Node.js 22+（见 .nvmrc）
nvm use

# 安装依赖
npm install

# 生成 Prisma Client（Prisma 7 起必须手动执行）
npx prisma generate

# 启动开发服务器
npm run dev
```

## 提交前检查

每次提交前必须通过：

```bash
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 代码检查
npm run test:unit    # Vitest 单元测试
npm test             # e2e 测试（含边界 + 故障注入）
```

pre-commit 钩子会自动运行 lint-staged（ESLint + Prettier），但完整测试需手动执行。

## 代码规范

- **TypeScript**：strict 模式，禁止 `any`（用 `unknown` + 类型收窄）
- **命名**：变量/函数用 camelCase，类型/接口用 PascalCase，常量用 UPPER_SNAKE_CASE
- **注释**：用中文写「为什么」，不写「是什么」（代码本身应该自解释）
- **错误处理**：区分「用户错误」（4xx）和「系统错误」（5xx），错误信息必须可行动
- **测试**：新功能必须有对应测试；测试要覆盖边界和故障路径，不只是 happy path

## 提交信息格式

使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <description>

<optional body>
```

类型：`feat` / `fix` / `perf` / `refactor` / `docs` / `test` / `chore`

示例：

```
feat(plan): 新增行程管家对话功能

step-5 驱动的行程问答，只依据行程事实回答，
涉及修改给一个可执行建议，用户点了才执行。
```

## PR 流程

1. 从 `main` 创建分支：`git checkout -b feat/your-feature`
2. 开发并通过所有检查
3. 提交 PR，填写 PR 模板
4. 等待 review 通过后合并

## 项目结构

```
app/            Next.js App Router（页面 + API 路由）
components/     React 组件
lib/            核心业务逻辑（planner / validate / amap / store 等）
tests/          测试（e2e 编排 + Vitest 单测）
scripts/        构建/测试/部署脚本
prisma/         数据库 schema
```

## 环境变量

参考 `.env.example`，复制为 `.env` 后填入实际值。**不要提交 `.env` 到 Git。**
