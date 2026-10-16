# 部署指南

前置认知：**生成一次行程要 3-15 分钟且任务状态在服务端内存**（1-4 天约 3-5 分钟；5-7 天走分日流式，约 10-15 分钟），所以本项目不能用「纯 serverless 函数」部署（函数响应后会被冻结，后台任务中断、轮询 404）。必须用**常驻 Node 服务**。

> **Node ≥ 22**（package.json engines 已约束；openai SDK v7 起要求 22）。Dockerfile 与 CI 均基于 node:22。

## 方案对比

| 方案 | 速度 | 备案 | 适合阶段 | 备注 |
|---|---|---|---|---|
| CloudBase 云托管（腾讯） | 快 | 需要 | 正式运营 | 按量计费，容器部署，国内访问快 |
| 轻量服务器 + Docker | 中 | 需要 | 正式运营 | 一台机器全包，最可控 |
| Vercel / Netlify | 快 | 无 | ❌ 不适用 | serverless 会冻结长任务，只能放静态演示 |

## 方式一：Docker（推荐，任意支持容器的平台通用）

```bash
# 本地构建
docker build -t travel-planner .

# 本地运行（密钥用环境变量注入，不要写进镜像）
docker run -d -p 3000:3000 \
  -e LLM_API_KEY=sk-xxx \
  -e LLM_BASE_URL=https://api.stepfun.com/step_plan/v1 \
  -e LLM_MODEL=step-5-preview \
  -e AMAP_WEB_SERVICE_KEY=你的高德key \
  -e DAILY_FREE_LIMIT=3 \
  --name travel-planner travel-planner
```

镜像基于 `output: "standalone"` 构建，体积约 150MB。健康检查可打 `GET /api/health`（返回 `status:ok` 与配置自检，不泄露密钥）。

> **Prisma 7 注意**：`@prisma/client` 已无 postinstall，`npm ci` **不会**自动生成 client。Dockerfile 已在构建层加 `npx prisma generate`（只读 schema，不连库，无需 DATABASE_URL）；若改用其他构建方式，务必确认 `.prisma/client` 已生成，否则 `DATA_STORE=postgres` 路径一跑就崩。`npm run preflight` 有 BLOCK 级检查兜底。

## 方式二：裸机 / 虚拟机（standalone 直跑，无需 Docker）

```bash
npm ci && npm run build
# ⚠️ 三个必须注意的点（都实测踩过）：
# 1) Prisma 7 起 @prisma/client 无 postinstall，npm ci 不生成 client，
#    缺 .prisma/client 会让 import 了 store 的路由在运行时崩：
npx prisma generate
# 2) output:standalone 下 npm start 不可用，必须直接跑 standalone 产物：
cp -r .next/static .next/standalone/.next/static   # 构建不会自动放进 standalone
mkdir -p .next/standalone/public && cp -r public/* .next/standalone/public/ 2>/dev/null
# 2) standalone 不读 .env，环境变量必须显式注入：
LLM_API_KEY=sk-xxx LLM_BASE_URL=... PORT=3000 node .next/standalone/server.js
```

实测：standalone + 显式 env 下 `/api/health` 返回 `llmConfigured:true`，真实生成（厦门 4 天）297s 完成，产物行为与 dev 一致。

## 方式二：CloudBase 云托管

1. 控制台开通云托管（按量付费），创建服务
2. 本地拉取/推送镜像到腾讯云 CCR，或直接用「本地代码部署」
3. 环境变量同上；常量配置同 Docker
4. 绑定域名（.txcloud.cn 临时域名可直接用，正式运营再换备案域名）

## 环境变量清单

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_API_KEY` | ✅ | step-5（或任何 OpenAI 兼容）密钥 |
| `LLM_BASE_URL` | ✅ | 默认 `https://api.stepfun.com/step_plan/v1` |
| `LLM_MODEL` | ✅ | `step-5-preview` |
| `LLM_MAX_TOKENS` | | 默认 64000，别调小（推理+正文共用，不足会空返回） |
| `LLM_REASONING_EFFORT` | | 默认 `low`，实测 medium 无收益且更慢 |
| `AMAP_WEB_SERVICE_KEY` | 建议 | 高德 Web 服务 key；不填则 MOCK 模式（POI 不验真，`verified=false`） |
| `AMAP_BASE_URL` | | 默认 `https://restapi.amap.com`，一般不用改 |
| `DAILY_FREE_LIMIT` | | 默认 3 次/天/IP（未登录） |
| `AUTH_PROVIDER` | | `none`（开发，验证码固定 123456）/ `sms` / `wechat` |
| `SESSION_SECRET` | 生产必改 | session cookie HMAC 密钥，换成随机长字符串 |
| `AUTH_USER_LIMIT` | | 默认 10 次/天（登录用户） |
| `SMS_APP_ID` / `SMS_SIGN` / `SMS_TEMPLATE_ID` | sms 时必填 | 短信三件套（应用 ID/签名/模板） |
| `SMS_SECRET_ID` / `SMS_SECRET_KEY` | sms 时必填 | 腾讯云 API 密钥（控制台 → 访问管理） |
| `PORT` | | 默认 3000 |

## 成本模型（LLM 费用，上线前必读）

每次生成实测（step-5-preview，effort=low）：prompt ~600 tokens，completion ~1.2-1.5 万 tokens（含推理），上限 64000。

**成本上限由配额锁死**：

```
月成本 ≈ 日生成次数 × 单次 completion tokens × 模型单价
日生成次数上限 = 陌生 UV × 3 + 登录用户数 × 10（双轨配额即成本闸门）
```

服务端日志每次打印 `[llm] 城市 天数 第N次尝试 prompt=xx completion=xx`，可按天汇总核对账单。要控成本就调 `DAILY_FREE_LIMIT` / `AUTH_USER_LIMIT` / `LLM_MAX_TOKENS`（调小会增加空返回重试概率，谨慎）。

## 上线当日 Runbook（按顺序执行）

```bash
# 0. 部署机/容器内：环境变量已注入（见上文），然后——
npm run preflight                  # ① 配置自检，🟢 GO 才能继续
npm run verify:amap                # ② 高德 key 5 秒验收（配了则 live 模式）
node scripts/smoke-deployed.mjs https://你的域名   # ③ 对着域名全链路冒烟（消耗 1 次当日配额）
# ④ 观察 24 小时：服务端 [llm] tokens 日志核对成本；/api/health 配监控告警
```

## 数据层：内存 → PostgreSQL（架构演进）

原版三块状态（任务/配额/验证码）都在内存 Map，重启即丢、多实例全废。现已抽象出 Store 接口（`lib/store/`），双实现：

| DATA_STORE | 实现 | 适用 |
|---|---|---|
| `memory`（默认） | globalThis Map，行为同原版 | 开发/测试/单机 |
| `postgres` | Prisma + PostgreSQL | 生产多实例 |

切换到 Postgres：
```bash
# 1. 建表（新环境用 db push；有迁移历史的环境用 db:migrate）
DATABASE_URL=postgres://... npm run db:push
# 2. 环境变量加两行
DATA_STORE=postgres
DATABASE_URL=postgres://...
# 3. 验证：/api/health 应返回 "store":"postgres"
```

契约测试：设了 `DATABASE_URL` 后跑 `npm test`，会自动起一台 postgres 模式的服务器执行任务持久化/配额计数的契约断言（阶段 P）；没设则自动跳过（memory 路径 151 断言不受影响）。

## 上线后必须跟进的事项

1. ~~配额换存储~~ / ~~任务态换存储~~：✅ 本轮已由 Store 抽象 + Postgres 实现解决（DATA_STORE=postgres）
3. ~~登录体系~~（M3 已完成，剩厂商凭据）：选短信（填 SMS_APP_ID/SIGN/TEMPLATE_ID，`AUTH_PROVIDER=sms`）或微信（填 WECHAT_APPID/SECRET + 备案回调域名，`AUTH_PROVIDER=wechat`）
4. **监控**：生成失败率 / 超时率 / 平均耗时（基线：1-4 天 3-5 分钟，5-7 天 10-15 分钟）
