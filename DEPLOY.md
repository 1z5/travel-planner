# 部署指南

前置认知：**生成一次行程要 3-10 分钟且任务在服务端进程内执行**（1-4 天约 3-5 分钟；5-7 天走分日流式，实测约 7 分钟——多天并发生成），所以本项目不能用「纯 serverless 函数」部署（函数响应后会被冻结，后台任务中断、轮询 404）。必须用**常驻 Node 服务**。

两层状态要分清：

- **行程（Plan）是持久化资产**：生成完成即落 Store，带持久分享 token（`/p/<token>`），进程重启不丢、分享链接长期有效。
- **任务（Job）是执行记录**：仍在进程内跑；进程被杀会中断，靠心跳 + 状态接口的「陈旧任务自愈」（`JOB_STALE_MS`，默认 12 分钟）让前端立刻拿到可行动 error，而不是白轮询 15 分钟。

> **Node ≥ 22**（package.json engines 已约束；openai SDK v7 起要求 22）。Dockerfile 与 CI 均基于 node:22。

## 方案对比

| 方案                     | 速度 | 备案 | 适合阶段  | 备注                                    |
| ------------------------ | ---- | ---- | --------- | --------------------------------------- |
| CloudBase 云托管（腾讯） | 快   | 需要 | 正式运营  | 按量计费，容器部署，国内访问快          |
| 轻量服务器 + Docker      | 中   | 需要 | 正式运营  | 一台机器全包，最可控                    |
| Vercel / Netlify         | 快   | 无   | ❌ 不适用 | serverless 会冻结长任务，只能放静态演示 |

## 方式一：Docker（推荐，任意支持容器的平台通用）

```bash
# 本地构建
docker build -t travel-planner .

# 本地运行（密钥用环境变量注入，不要写进镜像）
# DATA_STORE / DATABASE_URL / NEXT_PUBLIC_SITE_URL / AUTH_PROVIDER / SESSION_SECRET
# 是生产硬要求，缺任何一项 npm run preflight 都会 BLOCK（见下文环境变量清单）。
docker run -d -p 3000:3000 \
  -e LLM_API_KEY=sk-xxx \
  -e LLM_BASE_URL=https://api.stepfun.com/step_plan/v1 \
  -e LLM_MODEL=step-5-preview \
  -e AMAP_WEB_SERVICE_KEY=你的高德key \
  -e DAILY_FREE_LIMIT=3 \
  -e DATA_STORE=postgres \
  -e DATABASE_URL=postgres://user:password@host:5432/travel_planner \
  -e NEXT_PUBLIC_SITE_URL=https://your-domain.example \
  -e AUTH_PROVIDER=sms \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  --name travel-planner travel-planner
```

镜像基于 `output: "standalone"` 构建，体积约 150MB。健康检查可打 `GET /api/health`（返回 `status:ok` 与配置自检，不泄露密钥）。

> **Prisma 7 注意**：`@prisma/client` 已无 postinstall，`npm ci` **不会**自动生成 client。Dockerfile 已在构建层加 `npx prisma generate`（只读 schema，不连库，无需 DATABASE_URL）；若改用其他构建方式，务必确认 `.prisma/client` 已生成，否则 `DATA_STORE=postgres` 路径一跑就崩。`npm run preflight` 有 BLOCK 级检查兜底。

### 反代与客户端 IP（配额前提前提，必须读）

按 IP 的每日免费额度 / 小时限流 / 短信防轰炸都依赖「真实客户端 IP」。代码只信
**受信反代链**（`lib/client-ip.ts`）：XFF 从右往左数第 `TRUSTED_PROXY_HOPS` 个
（默认 1）。因此部署时必须满足其一：

- 前面有一层反代（nginx / 云托管 / 网关），并且它**追加**真实 IP（nginx 的
  `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` 或直接覆盖）；
- 或平台本身在入口注入 XFF（CloudBase 云托管默认行为），此时保持默认 `1`。

**不要**把 3000 端口直接暴露公网：客户端可以自带任意 `X-Forwarded-For`，
换一个头就是「新用户」，每日 3 次额度形同虚设（2026-10 审计 P0-3）。
没有反代时把 `TRUSTED_PROXY_HOPS=0`（此时无法拿到可信 IP，配额退化为全局限额，
只适合内网/演示）。

除按 IP 配额之外还有服务端兜底（不依赖 IP 可信）：`MAX_CONCURRENT_GENERATIONS`
（并发生成上限）、`MAX_CONCURRENT_LLM`（并发 LLM 调用上限）、`DAILY_GLOBAL_LIMIT`
（每日全站生成上限）。`GET /api/health` 的 `capacity` 字段可以直接看到当前占用。

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

| 变量                                          | 必填               | 说明                                                                                                                                        |
| --------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `LLM_API_KEY`                                 | ✅                 | step-5（或任何 OpenAI 兼容）密钥                                                                                                            |
| `LLM_BASE_URL`                                | ✅                 | 默认 `https://api.stepfun.com/step_plan/v1`                                                                                                 |
| `LLM_MODEL`                                   | ✅                 | `step-5-preview`                                                                                                                            |
| `LLM_MAX_TOKENS`                              |                    | 默认 64000，别调小（推理+正文共用，不足会空返回）                                                                                           |
| `LLM_REASONING_EFFORT`                        |                    | 默认 `low`，实测 medium 无收益且更慢                                                                                                        |
| `AMAP_WEB_SERVICE_KEY`                        | 建议               | 高德 Web 服务 key；不填则 MOCK 模式（POI 不验真，`verified=false`）                                                                         |
| `AMAP_BASE_URL`                               |                    | 默认 `https://restapi.amap.com`，一般不用改                                                                                                 |
| `AMAP_MAP_DISABLED`                           |                    | 设 `1` 关闭「真实地图」（静态地图有独立日配额，调试/截图时可临时关）                                                                        |
| `NEXT_PUBLIC_SITE_URL`                        | ✅                 | 对外绝对地址（`https://你的域名`）：分享页 OG/Twitter 卡片与绝对链接都基于它；缺省指 localhost                                              |
| `DATA_STORE`                                  | ✅                 | `postgres`（生产必须）；`memory` 仅本地/测试（重启丢 Plan、分享链接 404、配额归零）                                                         |
| `DATABASE_URL`                                | 存 postgres 时必填 | `postgres://user:pass@host:5432/db`（Prisma 7 + adapter-pg 只认 postgres 协议）                                                             |
| `METRICS_TOKEN`                               | 建议               | `GET /api/events/summary?token=` 的看板令牌；不配则看板一律 404（北极星指标不可见）                                                         |
| `DAILY_FREE_LIMIT`                            |                    | 默认 3 次/天/IP（未登录）                                                                                                                   |
| `AUTH_PROVIDER`                               | 生产必改           | `none`（仅开发，固定验证码 123456，生产会被 preflight 阻断）/ `sms` / `wechat`                                                              |
| `ALLOW_DEV_AUTH`                              |                    | 设 `1` 才允许生产用 `none`/dev provider（仅预发/内部演示，公网禁止）                                                                        |
| `SESSION_SECRET`                              | 生产必改           | session cookie HMAC 密钥，`openssl rand -hex 32`；缺失/默认值时生产拒绝签发与校验 session                                                   |
| `AUTH_USER_LIMIT`                             |                    | 默认 10 次/天（登录用户）                                                                                                                   |
| `REFINE_HOURLY_LIMIT`                         |                    | 默认 20 次/小时/IP（「换一个 / 一句话改一天 / 一键修复」，不占每日生成配额）                                                                |
| `ADJUST_HOURLY_LIMIT`                         |                    | 默认 60 次/小时/IP（「一键顺延时间轴」，不调模型、不占生成配额）                                                                            |
| `LLM_STREAM_DEADLINE_MS`                      |                    | 默认 600000（10 分钟）：单次流式调用的总时长兜底；上游挂住不发 chunk 时中止任务并退配额                                                     |
| `COPILOT_HOURLY_LIMIT`                        |                    | 默认 40 次/小时/IP（「行程管家」对话，调用 step-5；独立于生成/修改配额）                                                                    |
| `JOB_STALE_MS`                                |                    | 默认 720000（12 分钟）：running 任务超过这么久无心跳即判定中断                                                                              |
| `TRUSTED_PROXY_HOPS`                          | 生产必须确认       | 前面有几层受信反代（默认 1）：XFF 链从右往左数第 N 个才是真实客户端。直连公网设 0 时无法取到可信 IP，配额退化为全局限额——生产必须接一层反代 |
| `MAX_CONCURRENT_GENERATIONS`                  |                    | 默认 6：同时在跑的生成任务上限（进程内；多实例时是每实例上限）                                                                              |
| `MAX_CONCURRENT_LLM`                          |                    | 默认 12：同时在跑的 LLM 调用上限（生成 + refine + chat，每实例）                                                                            |
| `DAILY_GLOBAL_LIMIT`                          |                    | 默认 500：每日全站生成次数上限（每实例，UTC 日）——防伪造 IP/爆量烧穿账单的最后一道闸                                                        |
| `DAILY_GLOBAL_LLM_LIMIT`                      |                    | 默认 300：每日全站 LLM 调用次数上限（生成之外含改行程/行程管家，每实例，UTC 日）                                                            |
| `MAP_HOURLY_LIMIT`                            |                    | 默认 600/小时/IP：`/api/map` 静态图代理限流（防刷爆高德静态图日配额 / 堵死串行队列）                                                        |
| `PLACES_HOURLY_LIMIT`                         |                    | 默认 600/小时/IP：地址补全与必游地推荐限流                                                                                                  |
| `GEOCODE_HOURLY_LIMIT`                        |                    | 默认 120/小时/IP：逆地理编码限流                                                                                                            |
| `WEATHER_HOURLY_LIMIT`                        |                    | 默认 120/小时/IP：天气查询限流                                                                                                              |
| `SMS_APP_ID` / `SMS_SIGN` / `SMS_TEMPLATE_ID` | sms 时必填         | 短信三件套（应用 ID/签名/模板）                                                                                                             |
| `SMS_SECRET_ID` / `SMS_SECRET_KEY`            | sms 时必填         | 腾讯云 API 密钥（控制台 → 访问管理）                                                                                                        |
| `PORT`                                        |                    | 默认 3000                                                                                                                                   |

## 成本模型（LLM 费用，上线前必读）

**一次「生成」的 token 消耗按天数分流**（2026-10 实测，step-5-preview，effort=low）：

| 行程天数 | 生成方式        | LLM 调用次数 | 总 tokens 实测样本                                    |
| -------- | --------------- | ------------ | ----------------------------------------------------- |
| 1-4 天   | 单次调用        | 1            | 杭州 3 天 15,151 / 香港 3 天 28,805（跨境推理量翻倍） |
| 5-7 天   | 大纲 + 逐日流式 | 1 + 天数     | 京都 5 天 72,316 / 63,191（两个真实样本）             |

⚠️ **分日流式的成本约为单次路径的 4-5 倍**——按旧的「1.2-1.5 万/次」做预算会严重低估。7 天行程是 1 次大纲 + 7 次单日，预计 9 万 tokens 上下。

**成本上限由配额锁死**（配额即成本闸门）：

```
月成本 ≈ 日生成次数 × 该次行程的实际 tokens × 模型单价
日生成次数上限 = 陌生 UV × 3 + 登录用户数 × 10
```

做预算时按「日均行程天数 × 对应 tokens」加权估算，不要用单一均值——长行程用户会显著拉高均值。

**核对账单**：服务端对每次 LLM 调用打印一行 `[llm] 城市 天数|大纲|第N天 第M次 tokens=N`。注意**一次分日生成会产生 N+1 行**（大纲 + 每天各一行；重试会额外多几行），要按 job 聚合才是「一次生成的成本」。要控成本就调 `DAILY_FREE_LIMIT` / `AUTH_USER_LIMIT`（直接限制生成次数），或引导用户选更短的天数；`LLM_MAX_TOKENS` 别调小（会增加空返回重试概率，谨慎）。

## 上线当日 Runbook（按顺序执行）

```bash
# 0. 部署机/容器内：环境变量已注入（见上文），然后——
npm run preflight                  # ① 配置自检：必须 🟢 GO；🔴 NO-GO 时任何一项 BLOCK 都不许继续
npm run check:env                  # ①' 环境变量体检（格式/文档漂移/生产安全），BLOCK 同样不许继续
npm run verify:amap                # ② 高德 key 5 秒验收（配了则 live 模式）
node scripts/smoke-deployed.mjs https://你的域名   # ③ 对着域名全链路冒烟（含 Trip Check 核验层；生成一步消耗 1 次当日配额）
# ④ 观察 24 小时：服务端 [llm] tokens 日志核对成本；/api/health 配监控告警
```

**preflight 的 BLOCK 项就是「照默认配置上线会坏」的清单**（共 5 类，逐项修完再到 GO）：

1. `DATA_STORE` 必须 `postgres`（默认 `memory` = 重启丢分享链接、配额归零）；
2. `DATABASE_URL` 必须 `postgres://` 连接串（缺了 postgres 模式一启动就崩）；
3. `NEXT_PUBLIC_SITE_URL` 必须 https 绝对地址（否则分享页 OG 图全指 localhost）；
4. `AUTH_PROVIDER` 不能是 `none`（默认固定验证码 123456 = 任意手机号可登录）；
5. `SESSION_SECRET` 不能是开发默认值（公开常量 = 任意用户 session 可伪造）。

`METRICS_TOKEN` 缺失只是 WARN（主流程可用，但指标看板与北极星不可见）。

## 数据层：内存 → PostgreSQL（架构演进）

原版三块状态（任务/配额/验证码）都在内存 Map，重启即丢、多实例全废。现已抽象出 Store 接口（`lib/store/`），双实现：

| DATA_STORE       | 实现                       | 适用           |
| ---------------- | -------------------------- | -------------- |
| `memory`（默认） | globalThis Map，行为同原版 | 开发/测试/单机 |
| `postgres`       | Prisma + PostgreSQL        | 生产多实例     |

**本轮新增持久化行程（Plan）**：行程不再寄生在 2 小时 TTL 的 Job 里，而是独立落库（`Plan` 表：share token 主键 + `input` 原始条件 + `revision` 修订号 + 时间戳）。这带来两个部署含义：

1. **建表**：升级既有部署后必须应用数据库迁移（`npm run db:migrate`，即 `prisma migrate deploy`），否则 `/p/<token>` 与「改行程」会因缺表失败。迁移历史在 `prisma/migrations/`，schema 变更必须通过 `prisma migrate dev` 生成新迁移——**不要再直接用 `db push`**（push 不留迁移历史，生产 schema 演进无法审计与回滚）；
2. **分享链接不再过期**：旧链接（`/p/<jobId>`）仍兼容，但只有新链接是持久 token；生产 Postgres 模式不设过期时间（内存模式保留 30 天）。

切换到 Postgres：

```bash
# 1. 建表（新环境：应用迁移基线；CI 与生产都走这条）
DATABASE_URL=postgres://... npm run db:migrate
# 2. 环境变量加两行
DATA_STORE=postgres
DATABASE_URL=postgres://...
# 3. 验证：/api/health 应返回 "store":"postgres"
```

> **历史库兜底**：如果是 v8.1 之前用 `db push` 直接建过表的库（没有 `_prisma_migrations`
> 记录），先执行一次 `npx prisma migrate resolve --applied 20261022000000_init`
> 告诉 Prisma「基线已在」，再跑 `npm run db:migrate` 就不会重复建表。

契约测试：设了 `DATABASE_URL` 后跑 `npm test`，会自动起一台 postgres 模式的服务器执行任务持久化/配额计数的契约断言（阶段 P）；没设则自动跳过（memory 路径的 e2e 断言不受影响）。

### 备份与恢复（Postgres，商业化前的硬性要求）

行程是**用户资产**（分享链接长期有效），丢了就是事故。一人公司的最低标准：

```bash
# ① 每日备份（cron 或云托管的定时任务）：压缩 + 保留 14 天
pg_dump "$DATABASE_URL" | gzip > "backups/travel-planner-$(date +%Y%m%d).sql.gz"

# ② 恢复（先停服务再恢复；standalone 是无状态进程，重启即可）
gunzip -c backups/travel-planner-20261024.sql.gz | psql "$DATABASE_URL"

# ③ 恢复演练（每季度一次，只做不做记录等于没做）
#    用备份在新库起一套：prisma migrate deploy → 灌备份 → node scripts/smoke-deployed.mjs https://staging
```

保留策略：备份 14 天 + 每周一份月度备份保留 6 个月。数据库本身按云厂商的自动快照再兜一层。

> `memory` 模式没有备份概念（重启即丢）——它只适合本地/测试。生产必须 `DATA_STORE=postgres`。
> 健康检查现在会真的连库（`/api/health` 返回 `db:ok|error`，失败 503），DB 挂掉时云托管会把实例摘掉，
> 不会再往一个必然 500 的服务导流。

## 数据源与外部依赖（v3 起）

- **高德 POI 详情**：`/v3/place/text` 以 `extensions=all` 请求，获取评分/营业时间/人均/电话；响应体比 base 大但请求数不变，结果只缓存解析后的结构（`poiCache` 30 分钟）。
- **营业时间解析**：拿不准一律 `unknown` 且不告警（跨零点/复杂节假日/无星期限定的重叠窗口）；节假日安排以官方公告为准。**不额外依赖任何第三方数据源**。
- **一键顺延**：纯计算 + 已有 `legs`，不打高德；缺真实路段（MOCK/旧行程）时返回 422 引导改用 AI 重排。
- **流式总时长兜底**：见 `LLM_STREAM_DEADLINE_MS`。SDK 的 timeout 只约束 chunk 间隔，上游「挂着不发数据」会让任务变成永远 running 的僵尸——这是生产必须的兜底。

## 成本模型补充：改行程（refine）的调用量

「换一个景点」「一句话改一天」是**单次小调用**（只生成一天/一个点，输出量约为整份行程的 1/N），但会额外复跑一次体检（POI 验真有 30 分钟缓存，命中率高时几乎零成本）。成本上按「每次改 ≈ 0.2-0.5 次整份生成」量级估算，并用 `REFINE_HOURLY_LIMIT`（默认 20 次/小时/IP）作为闸门。改行程**不占用**每日生成配额（它是迭代既有行程，不是新增一次生成）。

## 上线后必须跟进的事项

1. ~~配额换存储~~ / ~~任务态换存储~~：✅ 已由 Store 抽象 + Postgres 实现解决（`DATA_STORE=postgres`）
2. ~~登录体系~~（M3 已完成，剩厂商凭据）：选短信（填 SMS_APP_ID/SIGN/TEMPLATE_ID，`AUTH_PROVIDER=sms`）或微信（填 WECHAT_APPID/SECRET + 备案回调域名，`AUTH_PROVIDER=wechat`）
3. **监控**：生成/改行程失败率、超时率、平均耗时（基线：1-4 天 3-5 分钟，5-7 天约 7 分钟；改行程 20-90 秒）、静态地图上游错误率（`[staticmap]` 日志）
4. **静态地图日配额**：个人高德 key 的静态地图有独立日配额，线上如遇 502/配额类错误，可临时置 `AMAP_MAP_DISABLED=1` 优雅回退到示意路线图（前端已做 fallback）
