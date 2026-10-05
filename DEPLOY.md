# 部署指南

前置认知：**生成一次行程要 3-5 分钟且任务状态在服务端内存**，所以本项目不能用「纯 serverless 函数」部署（函数响应后会被冻结，后台任务中断、轮询 404）。必须用**常驻 Node 服务**。

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

## 方式二：裸机 / 虚拟机（standalone 直跑，无需 Docker）

```bash
npm ci && npm run build
# ⚠️ 两个必须注意的点（都实测踩过）：
# 1) output:standalone 下 npm start 不可用，必须直接跑 standalone 产物：
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
| `SMS_APP_ID` / `SMS_SIGN` / `SMS_TEMPLATE_ID` | sms 时必填 | 短信服务商三件套 |
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

## 上线后必须跟进的事项

1. **配额换存储**：内存 Map 每实例独立、重启清零 → 上 Redis（云托管可挂云数据库 Redis 版）
2. **任务态换存储**：同理，jobs Map 换 Redis，否则多实例部署轮询会 404
3. ~~登录体系~~（M3 已完成，剩厂商凭据）：选短信（填 SMS_APP_ID/SIGN/TEMPLATE_ID，`AUTH_PROVIDER=sms`）或微信（填 WECHAT_APPID/SECRET + 备案回调域名，`AUTH_PROVIDER=wechat`）
4. **监控**：生成失败率 / 超时率 / 平均耗时（当前基线 3-5 分钟）
