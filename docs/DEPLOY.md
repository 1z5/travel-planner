# 部署指南

| 入口       | 运行方式                                        | 需要什么                                      |
| ---------- | ----------------------------------------------- | --------------------------------------------- |
| 主站       | 常驻 Node.js 进程，或仓库 Dockerfile 构建的容器 | PostgreSQL 用于持久化，模型与高德服务按需配置 |
| 离线验真台 | GitHub Pages 或静态托管                         | 已构建的 HTML 和 Service Worker               |

生成任务在请求返回后继续运行，部署平台应允许常驻进程处理后台任务。长期使用建议选 PostgreSQL。内存模式用于本地测试，重启会丢失行程与分享链接。主站的健康检查在 `/api/health`，其中 `commit` 用于核对部署版本。

## 主站配置

以 [`.env.example`](../.env.example) 为配置索引。使用环境变量或托管平台的密钥设置传入实际值。

| 配置                                       | 用途                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `DATA_STORE=postgres`、`DATABASE_URL`      | 持久化行程、任务和账号相关状态                                            |
| `LLM_BASE_URL`、`LLM_MODEL`、`LLM_API_KEY` | 同一 OpenAI 兼容服务的地址、模型和密钥；当前示例为 TokenHub + `hy4-flash` |
| `LLM_REASONING_EFFORT`                     | 网关拒绝推理参数时设为 `off`，请求会省略该字段                            |
| `LLM_MAX_TOKENS`                           | 单次生成输出上限；HY4 Flash 支持到 64000                                  |
| `AMAP_WEB_SERVICE_KEY`                     | 在线 POI、路线、地图与天气，留空时会降级                                  |
| `NEXT_PUBLIC_SITE_URL`                     | 公开 HTTPS 地址，用于站点地图和分享元信息                                 |
| `AUTH_PROVIDER`、`SESSION_SECRET`          | 需要登录时配置实际登录服务与随机会话密钥                                  |
| `TRUSTED_PROXY_HOPS`                       | 与实际反代层数匹配，配额依赖可信转发地址                                  |
| `DEMO_SEED=1`、`JOB_LINK_FALLBACK=0`       | 启用只读预置演示，并关闭旧任务链接读取                                    |

公开部署前设置生成、全站模型调用和并发上限。检验或备份生产数据库时使用受控连接。避免在公开 issue、配置示例或日志里粘贴密钥和行程链接。

## PostgreSQL 与自托管

首次创建空库或已有迁移记录的库，在启动新版本前应用仓库的迁移。下列命令使用已注入环境的 `DATABASE_URL`。

```bash
npm ci
npm run db:generate
npm run db:migrate
```

旧实例若通过 `db push` 建库，先确认现有结构并建立迁移基线。升级前备份，先在数据库副本验证。生成任务跨进程重启会中断，已提交的行程继续保存在数据库。

容器方式使用 [Dockerfile](../Dockerfile)。先完成数据库迁移，再从文件加载运行配置。

```bash
docker build -t ai-travel-companion .
docker run --env-file .env -p 127.0.0.1:3000:3000 ai-travel-companion
```

以 Node.js 直接运行时，`npm run build` 后把 `.next/static` 和 `public` 分别复制到 `.next/standalone/.next/static` 与 `.next/standalone/public`，再注入环境变量启动 `node .next/standalone/server.js`。

## Render

现有服务配置见 [`render.yaml`](../render.yaml)。其中同时保留了 `plan: free` 和 `preDeployCommand`，而 Render 仅在付费 Web Service 上提供该钩子。新建免费实例时，通过常规 Web Service 配置使用相同的构建与启动命令，并在部署前从受控环境单独迁移外部数据库。免费实例可能休眠，第一次打开可能需要等待。 [Render 部署文档](https://render.com/docs/deploys)

发布后先核对 `/api/health` 的 `commit`，再对目标运行 `npm run smoke -- https://你的域名`。冒烟包含一次生成，会消耗配置服务的额度。

## 静态入口

[Pages 工作流](../.github/workflows/pages.yml)发布仓库里的 `public/verify-playground.html` 和 `public/verify-playground-sw.js`。GitHub Pages 的发布来源选 GitHub Actions。静态验真台在浏览器内计算，可在首次加载并缓存后离线使用。引擎或模板更改后执行 `npm run playground:build` 更新产物。

[苏州示例](https://travel-planner-demo.onrender.com/p/share_Z5oYam8ahjqb)用于展示体检发现的问题，[成都示例](https://travel-planner-demo.onrender.com/p/share_BP3e7AKOJ4ML)用于展示调整后的安排。替换预置样本时用 `npm run demo:gen` 和 `npm run demo:polish`，同时核对 `lib/demo/demo-links.ts` 中的稳定链接。
