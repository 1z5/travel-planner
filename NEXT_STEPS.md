# 上线剩余行动清单（NEXT STEPS）

本文件是给「接手的人」看的：做什么、为什么、怎么做。工程侧已就绪（见 README 的实测数据与测试章节），剩下的都是需要账号/资金/决策的外部事项。

## 当前状态（一句话）

代码就绪：生成（含 5-7 天分日流式）/体检/配额/三种登录/分享闭环全部实现并有测试覆盖（**151 条 e2e + 50 条单测**，真实模型冒烟通过）；仓库 `1z5/travel-planner` 同步；CI 六道门（含依赖审计与 Prisma Client 生成）。**未上线的原因：三个外部输入未就位。**

技术栈已全面升级到当前最新稳定版：Next 16 / React 19 / openai SDK 7 / zod 4 / Prisma 7 / TypeScript 5.9。（TypeScript 7 实测不可用——Next 15.5 的配置加载器需要 `ts.sys.fileExists`，等 Next 支持后重试，过程记录在 CHANGELOG。）

## 待办 1：高德 Web 服务 key（约 10 分钟，免费）

**为什么**：当前 MOCK 模式下 POI 不验真、不通勤估算——核心卖点「把绕路和幻觉挡在出发前」尚未生效。**这是三个待办里唯一免费的，也是性价比最高的。**

**步骤**：
1. [高德控制台](https://console.amap.com/dev/key/app) → 创建应用 → 添加 Key → 服务平台选 **「Web服务」**（选错类型不生效）
2. 填入 `.env`：`AMAP_WEB_SERVICE_KEY=你的key`
3. `npm run verify:amap` —— 5 秒验收（key 有效性 / POI 验真 / 通勤矩阵，错误码有解读）
4. `DAILY_FREE_LIMIT=200 npm run dev` + `npm run eval:cases` —— 20 城量化评测（验真率/绕路误报率/预算贴合度），报告落 `eval-results/`
5. 根据评测结果决定是否调整 `lib/validate.ts` 的阈值（当前：通勤 >120 分钟预警、日净时长 >10 小时预警）

## 待办 2：登录体系（二选一）

**为什么**：「陌生人可注册使用」的前置；登录后配额从 3 次/天提升到 10 次/天。

| 方案 | 前置条件 | 配置 |
|---|---|---|
| **短信**（推荐，无域名依赖） | 腾讯云实名 + 短信包（约 ¥100 起）+ 签名/模板审核 | 填 `SMS_SECRET_ID/SECRET_KEY/APP_ID/SIGN/TEMPLATE_ID`，`AUTH_PROVIDER=sms`。代码已实现（TC3 直签），零开发 |
| **微信 OAuth** | 公众号/开放平台 appid + **ICP 备案域名**（回调要求） | 填 `WECHAT_APPID/SECRET`，`AUTH_PROVIDER=wechat`。代码已实现（含 CSRF 防护） |

⚠️ **如果选微信：ICP 备案周期 1-2 周，建议最早启动**（先提交备案，审核期间做完待办 1 和 3）。

## 待办 3：部署上线（约半天）

**为什么**：陌生人可用的唯一途径。注意：生成为长任务——**1-4 天约 3-5 分钟，5-7 天约 7 分钟**（分日流式，多天并发生成）——且任务态需跨轮询保持，**必须用常驻服务，不能用纯 serverless**。

**步骤**（详见 DEPLOY.md 的 Runbook）：
1. 选平台：CloudBase 云托管（推荐，国内访问快）/ 轻量服务器 + Docker
2. 生产构建 `npm run build` → standalone 产物（镜像约 150MB，Dockerfile 已备；**Prisma 7 起构建时需先 `npx prisma generate`，Dockerfile 与 CI 均已包含该步**）
3. 环境变量注入（**standalone 不读 .env**，必须显式注入；清单见 DEPLOY.md）
4. `npm run preflight` → 🟢 GO 才能继续（含 Prisma Client 已生成的 BLOCK 级检查）
5. 部署后 `node scripts/smoke-deployed.mjs https://你的域名` 全链路验收
6. 观察 24 小时：`[llm]` token 日志核对成本（成本模型见 DEPLOY.md）

## 已知遗留（上线后跟进，不阻塞）

- **预算利用率略低于契约**：prompt 承诺「至少用掉预算 80%」，真实模型实测 78%（京都 5 天 ¥7020/¥9000）。已从 58% 提升到 78%（锚点区间生效），但模型仍偏保守。下轮可把锚点下限从 0.8 收紧到 0.85 再测——注意别逼模型用「凑数项目」填预算
- **POI 验真未生效**：见待办 1，缺 key
- 配额与任务态换 Redis（多实例部署必需；单机部署可暂缓）
- 出境游（签证/汇率，用户已试过香港 case，模型处理良好但数据源未接）、酒店/机票比价（需企业资质）、预算记账

## 决策记录（为什么是现在这样）

关键工程决策与踩坑记录见 CHANGELOG.md；测试体系见 README「测试」节；部署陷阱见 DEPLOY.md。
