# 安全与项目底座审计（只读）· 2026-10-28

> **快照**：`git HEAD = 4191f99`（与线上 `/api/health` 的 `commit:"4191f99"` 一致）＋工作区未提交改动（见 §0.3）。
> **验证方式**：静态审阅（file:line）＋ 生产只读请求（GET/HEAD、1 次 `POST /api/verify`、`OPTIONS`、`curl -sD-`）＋ `npm audit --omit=dev`。
> **未做**：任何写/生成/修复/撤销请求、压测、`npm test/gate`、装依赖、改代码。写入类结论均按代码路径判定，未在生产实际利用（见 §5 未验证清单）。
> **纪律**：本文件是本次审计唯一产出；不构成对现有已记录风险的重述，只补增量。

## 0. 结论（先看这里）

- 上一轮审计的 P0-3（XFF 首值伪造）、P1-4（高德代理无限流）**已修复**并可验证：`lib/client-ip.ts:74-89` 从右往左取受信跳数、`lib/proxy-rate-limit.ts:38-48` 覆盖 map/places/geocode/weather。
- 本轮**没有 Critical**；最需要处理的是「**公开端点 body 无上限**」和「**MCP 线上无鉴权无限流且与自身文档矛盾**」两件 High/High-ish（线上部署版本）。
- 三处与「可信证据」定位直接冲突的中风险：**jobId 弱随机 + 旧链接读回**（未授权读取面）、**DEMO_SEED 公开 token 可被任何人改写**、**restore 信任客户端富字段可伪造「已核验/已修复」徽章**。
- 演示部署的 `DATA_STORE=memory + DEMO_SEED=1` 与仓内 `check:env` 的 BLOCK 规则冲突，且 Render buildCommand 不跑 check:env——**生产自检形同虚设**（演示取舍，但必须显式化）。
- 安全头在线上缺 HSTS/COOP/CORP 且暴露 `X-Powered-By`；工作区已有未提交修复。
- 62 处 `console.log/error` 中未发现密钥/手机号泄漏（dev provider 除外）；客户端 bundle 无 sourcemap、无密钥；`.env` 从未进 git；SSRF 面经确认均为固定上游。

## 0.3 工作区并发改动（审计期间由其他任务/Lead 进行，未提交、未部署）

`M .env.example / app/api/mcp/route.ts / app/api/plan/check/route.ts / app/api/plan/repair/route.ts / next.config.ts`，新增未跟踪 `lib/http-body.ts`、`lib/http-origin.ts`、`tests/lib/http-guards.test.ts`。
内容：MCP 加 `MCP_HOURLY_LIMIT` 限流、check/repair 加 16 KiB body 上限与 Origin 校验、`poweredByHeader:false`、COOP/CORP/HSTS（按 `RENDER_EXTERNAL_URL` 条件）。**下表「线上/HEAD」结论基于已部署的 4191f99；工作区修复仅覆盖部分端点**（见 §3 建议 1）。

## 0.4 修复状态（2026-10-28 加固后，由 Lead 回填）

> 本表记录审计发现的处理结果；「已修」= 代码已改并进 gate/部署冒烟，「部分」= 只修了主风险面，
> 「接受」= 设计取舍（见 §4）。审计本身保持只读快照，不改写原结论。

| #   | 状态               | 落地内容                                                                                                                                       |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | 已修               | 全部 JSON 端点接 `lib/http-body.ts::readJsonBody`（16–64 KiB；restore 300 KiB；verify/mcp 256 KiB 不变），超限 413                             |
| R2  | 已修               | `/api/mcp` 加 `MCP_HOURLY_LIMIT`（120/h/IP），README 改为「公开 + 限流」事实口径                                                               |
| R3  | 已修（残余接受）   | jobId 改 `crypto.randomBytes(16)`；status/ics 限流 + ics `private,no-store`；128 bit 下 job 兜底枚举不可行（postgres 关闭兜底留待真实上线）    |
| R4  | 已修               | `DEMO_SEED` 行程 `plan.demo=true`；refine/restore/repair/adjust/candidates 写操作 403                                                          |
| R5  | 已修               | restore 剥离 `tripCheck/verified/verification/verifiedAt/grounding/verificationReport`，warnings 由 `refreshTimeWarnings` 重算，整份标记未核验 |
| R6  | 已修               | 海报/OG 按 IP 限流；海报 `public, s-maxage=3600, stale-while-revalidate=86400`；OG 429                                                         |
| R7  | 接受（演示）       | memory + DEMO_SEED 仍是演示取舍；真实上线前 `DATA_STORE=postgres` + `check:env` 是硬前置（未在本轮改变）                                       |
| R8  | 已修（待部署验证） | HSTS（HTTPS 条件）、COOP、CORP、`X-DNS-Prefetch-Control`、关闭 `X-Powered-By`                                                                  |
| R9  | 已修               | `/api/auth/verify` 失败按手机号+IP 10/h 限流（429）                                                                                            |
| R10 | 已修               | 微信回调 redirect 改 URL origin 同源校验（拒绝 `//`、`/\`、绝对外站）                                                                          |
| R11 | 已修               | `crossSiteWriteError` 铺到全部状态变更端点（无 Origin 客户端放行）                                                                             |
| R12 | 部分               | ics 加 `private,no-store`；海报改为可缓存 1h（传播物，URL 即 token，按设计接受）                                                               |
| R13 | 已修               | 私页 `X-Robots-Tag: noindex, noarchive`；SW 只缓存 `/t`（不再缓存 `/p`），缓存版本升 v2                                                        |
| R14 | 已修               | events `meta` 仅原始值 + ≤1 KiB，超限 400                                                                                                      |
| R15 | 部分               | ci.yml 加 `permissions: contents: read`；actions 浮动 tag 与 `fast-uri` moderate（上游无 fix）保留跟踪                                         |
| R16 | 接受               | 占位邮箱/health 信息面/CSP `unsafe-inline` 为已知取舍（上线前替换邮箱）                                                                        |

**部署验证**：`scripts/smoke-deployed.mjs` 新增安全探针——安全响应头、超大 body→413、
演示行程写→403；与功能冒烟同跑，避免「加固只活在代码里」。

## 1. 风险总表

| #   | 严重度         | 风险                                                                                                                            | 影响                                                                                                            | 关键证据                                                                                                                                                                | 最小修复                                                                                                             | 已接受?                        |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| R1  | **High**       | 12 个 JSON 写/读端点裸 `req.json()`，无 body 上限                                                                               | 公开站单实例（Render free 512MB）可被大 body 打 OOM/拖慢；verify/mcp 之外的端点全部无防线                       | `app/api/plan/{restore:41,refine:144,chat:72,extract:38,route:176,clone:70,adjust:61,candidates:80,replan:82}`、`app/api/events:47`、`app/api/auth/{code:17,verify:16}` | 统一用工作区 `lib/http-body.ts` 的 `readJsonBody`（普通端点 16–64 KiB），保留 verify/mcp 256 KiB；错误码沿用 413     | 否                             |
| R2  | **High**       | `POST /api/mcp` 在线上**无鉴权、无限流**、CORS `*`；自身注释写「不要直接挂公网」但 render.yaml 公开部署                         | 任意脚本可无限刷确定性体检/修复（CPU），且与文档边界自相矛盾                                                    | HEAD `app/api/mcp/route.ts:63-90`（无 rate limit）；`render.yaml` 公开 blueprint；mcp/README「诚实边界」                                                                | 采纳工作区 MCP 限流；补**全局并发/CPU 闸门**（见 R6）；文档改成「公开端点 + 限流」而不是「不要挂公网」               | 否（工作区已修限流）           |
| R3  | Medium         | jobId 是能力凭据但随机性弱：`Math.random` 4×base36≈20.7 bit；`/api/plan/status`、`/api/plan/ics`、`/p/<jobId>` 无速率限制       | 结合时间戳/Math.random 状态预测的未授权读取面（理论上可读他人行程）；旧链接 2h 内可读                           | `lib/jobs.ts:177`；`app/api/plan/status/route.ts:9-14`；`app/api/plan/ics/route.ts:12-16`；`lib/plan-repo.ts:130-137`；CHANGELOG:1279 已自认「可枚举」                  | `newId()` 改 `crypto.randomBytes(16)`；status/ics 按 IP 限流；postgres 生产模式关闭 job 兜底                         | 部分（仅记录可枚举）           |
| R4  | Medium         | 分享 token 即写能力 + `DEMO_SEED=1` 的演示 token 写在 DEMO.md → 公开可写                                                        | 任何人可 refine/restore/repair 演示行程（restore 不调 LLM、无内容校验），可公开篡改演示工件/刷「已修复」链      | `render.yaml:33-34`；`lib/demo-seed.ts:22,37-46`；`DEMO.md:54-55`；`refine:159-168`；`restore:60-78`                                                                    | demo 记录打 `readOnly/demo` 标记，写端点一律 403；或演示用固定只读种子、不开放写                                     | 否                             |
| R5  | Medium         | `restore` 原样信任客户端回传的富字段（`verification`/`tripCheck`/`warnings`/`legs`/`grounding`）                                | 持 token 者可让分享页显示伪造的「POI 已核验」「已确定性修复 + 假凭据链」——直接击穿核心「可复算证据」叙事        | `lib/plan-restore.ts:17,67,88-89`；`app/(app)/p/[id]/page.tsx:125-139,179-189`                                                                                          | restore 时剥离/服务端重算受信字段（tripCheck、verification、verified、warnings）；或改为服务端保存上一版而非信客户端 | 否                             |
| R6  | Medium         | 海报/OG 图片生成（Satori 1080×1920）**零限流**，且 `Cache-Control: public, max-age=0, must-revalidate` 每次重算                 | 单实例 CPU 放大 DoS（免费实例仅 0.1–1 vCPU），且 `public` 允许中间缓存私有工件                                  | `app/p/[id]/poster/route.tsx:25-37`；`app/p/[id]/check/poster/route.tsx:34-43`；线上实测缓存头                                                                          | 加 per-IP 限流 + `s-maxage` 按 revision/凭据 ID 缓存（如 `public, s-maxage=3600`）；或统一到全局 CPU 闸门            | 否                             |
| R7  | Medium         | 生产 blueprint 用 memory（未设 `DATA_STORE`）+ `DEMO_SEED=1`；buildCommand 不跑 `check:env/preflight`                           | 重启/免费实例休眠即丢全部行程与配额（分享链接 404）；本仓 `check:env` 明确 BLOCK 该配置，部署时无人拦截         | `render.yaml:21-27,29-83`（无 DATA_STORE）；线上 health `store:"memory"`；`scripts/check-env.mjs:132,148`                                                               | 演示可在 buildCommand 加 `npm run check:env` 并给显式 `DEMO_MODE=1` 豁免；真实上线前必须 postgres                    | 是（DEMO.md 已写，但需显式化） |
| R8  | Medium         | 线上缺 HSTS、COOP、CORP；`X-Powered-By: Next.js` 暴露                                                                           | 首访降级窗口（Render 有 http→https 跳转，风险受限）、版本指纹                                                   | 实测响应头（见 §7）；HEAD `next.config.ts:35-61`                                                                                                                        | 采纳工作区改动（已含 HSTS 条件、COOP/CORP、`poweredByHeader:false`）并验证生产                                       | 否（工作区已修）               |
| R9  | Medium（条件） | `/api/auth/verify` 无尝试次数限制；验证码 6 位、TTL 5min，失败不计数                                                            | 仅当 `AUTH_PROVIDER=sms` 时：分布式撞码（10^6/5min）有账号接管面；当前演示站 `authProvider:"disabled"` 不可利用 | `app/api/auth/verify/route.ts:15-27`；`lib/auth/sms.ts:112-119,121-123`                                                                                                 | 加「每手机号+IP 10 次/小时」失败计数，超限作废本次 code                                                              | 否                             |
| R10 | Low            | 微信 OAuth 回调开放重定向：`redirect.startsWith("/")` 可被 `//evil.com`、`/\evil.com` 绕过                                      | 已配置微信登录时可钓鱼跳转（需完成 OAuth；当前未配置 WECHAT_*）                                                 | `app/api/auth/wechat/callback/route.ts:29-39`；实测 `new URL("//evil.com",origin)`→`https://evil.com/`                                                                  | 改 `const u=new URL(redirect,origin); if(u.origin!==req.nextUrl.origin) redirect="/"`，并对 `\` 归一化               | 否                             |
| R11 | Low            | HEAD 全网无 Origin/Sec-Fetch-Site 校验；工作区只给 plan/repair 加了                                                             | CSRF 面本来就小（写操作靠 URL/body 里的 token；JSON Content-Type 触发预检且无 CORS 头）；属纵深防御缺口         | `git grep sec-fetch-site HEAD` 为空；工作区 `lib/http-origin.ts`                                                                                                        | 把 `crossSiteWriteError` 应用到 refine/restore/chat/extract/clone/adjust/replan/events/logout                        | 否（工作区部分）               |
| R12 | Low            | 私有工件缓存口径不一致：`/api/plan/ics` 无 `Cache-Control`；poster 为 `public`；其余私页 `private,no-store`                     | 中间缓存/共享设备可能留存带 token 的日历/海报                                                                   | 线上实测：ics 无缓存头、poster `public,max-age=0`、`/p/*` 页面 `private,no-cache,no-store`                                                                              | ics 加 `Cache-Control: private, no-store`；poster 改 `private` 或按 revision 做 public 缓存                          | 否                             |
| R13 | Low            | 分享/报告页无 `X-Robots-Tag: noindex`，仅 robots.txt；SW 把 `/p/*` 导航写入 CacheStorage（永久，忽略 no-store）                 | 搜索引擎/聚合器/转发预览可能索引或缓存私有行程；共用设备上离线副本长期驻留                                      | `app/robots.ts:13-18`；线上响应头无 X-Robots-Tag；`public/sw.js:45-58`                                                                                                  | 私页加 `X-Robots-Tag: noindex, noarchive`；SW 只缓存 `/t/` 或对 `/p/` 用网络优先且退出登录/关闭时清缓存              | 否                             |
| R14 | Low            | `POST /api/events` 的 `meta` 为任意 JSON（无大小/键白名单）；postgres 的 TripEvent 无 TTL/清理                                  | 公开可写表增长面（存储成本/看板污染）；memory 模式有 5000 条上限兜底                                            | `app/api/events/route.ts:21-30`；`prisma/schema.prisma:72-83`；`lib/store/postgres.ts:220-223`（只清 job/smsCode）                                                      | `meta` 限 1KiB 或按事件名白名单；postgres 加保留期清理                                                               | 否                             |
| R15 | Low            | CI 未声明 `permissions:`（默认 token 权限）；actions 用浮动 tag；`npm audit` 6×moderate 且 CI 只 `--audit-level=high`           | 供应链/权限过大；已知 moderate 不阻断                                                                           | `.github/workflows/ci.yml`（无 permissions）；`keep-warm.yml:16` 有；`npm audit --omit=dev` 输出                                                                        | ci.yml 加 `permissions: contents: read`；action 固定 SHA；tracking prisma→fast-uri 上游                              | 部分（moderate 已知）          |
| R16 | Info           | 占位邮箱 `security@/privacy@your-domain.example`；`/api/health` 暴露 store/commit/capacity；CSP 含 `script-src 'unsafe-inline'` | 漏洞报告渠道不可用；信息面轻微；CSP 弱化但当前无注入 sink                                                       | `SECURITY.md:8`；`privacy` 页:108；`app/api/health/route.ts:41-58`；`next.config.ts:35-45`                                                                              | 上线前替换真实邮箱；health 只保留 status/commit；CSP 后续改 nonce/hash                                               | 是（health/CSP 为设计取舍）    |

## 2. 逐项结论与证据

### 2.1 认证、会话、CSRF

- Cookie 口径合规：`HttpOnly; SameSite=Lax; Path=/; Secure`（生产）——`lib/auth/session.ts:114-124`；session 7 天、HMAC-SHA256 + `timingSafeEqual`（`:47-49,91-95`）。
- 默认密钥 fail-closed：生产 `SESSION_SECRET` 缺失/为公开默认值时**拒绝签发与校验**，且 provider 降级 `DisabledProvider`——`lib/auth/guards.ts:70-84`、`lib/auth/session.ts:23-41`、`lib/auth/providers.ts:83-92`；线上实测 `authProvider:"disabled"`，无登录面。
- CSRF：写端点全部用「URL/body 里的 token」而非 cookie 授权；cookie 仅用于配额与 `/api/auth/logout`。跨站 JSON POST 会触发预检且这些端点无 CORS 头，实际不可利用；但 HEAD 无 Origin 校验（R11）。logout 可被跨站顶层 POST 触发（SameSite=Lax 不带 cookie，仅清 cookie，无实际危害）。
- 登录链路：`/api/auth/code` 有单手机号 5/h + 单 IP 20/h（`app/api/auth/code/route.ts:25-32`）；`/api/auth/verify` 无尝试上限（R9）。
- 微信链路：回调直接 `wechatExchange` 并 `createSession`，**不经过** `isProductionAuthMisconfigured` 守卫——若线上保留 `WECHAT_APPID/SECRET` 但 `AUTH_PROVIDER=none`（意图关登录），回调仍可签发 session（Low；当前未配置，未利用）。`app/api/auth/wechat/callback/route.ts:15-47`。
- 会话无服务端撤销（7 天有效、多实例/重启仍有效），仅靠过期——`lib/auth/session.ts:6-13` 已注明取舍。

### 2.2 授权模型（分享 token 即能力）

- 设计已声明：`API.md:477,841`、`docs/adr/014-trip-check-in-product.md:49`——「拿到链接的人可以一起编」是产品主张；refine/restore/repair 用同一个 `shareId` 作为唯一凭据（`refine:159-168`、`restore:60-66`、`repair:169-178`），**无独立编辑凭据、无 expectedRevision 强制**（repair 可选、refine/restore 无）→ last-write-wins。
- 旧 job 链接：写端点全部 404（只读语义成立：`refine:160-168`、`restore:61-66`、`repair:169-178`、`replan:97-106`、`clone:89-101`）；但**读**仍走 `resolvePlan` 的 job 兜底（`lib/plan-repo.ts:130-137`），而 jobId 弱随机（R3）。
- `PlanView` 的 `ownerCheck` 只是 localStorage 提示（`components/PlanView.tsx:196,263-270`），**不是**服务端边界：真正边界就是 token 是否泄漏；文档/UI 措辞不要把它说成「只改 URL 改不了别人的行程」（API 层改不了，但拿到 token 就能改）。
- demo 特例（R4/R5）是当前最容易被公开利用的授权面。

### 2.3 限流、配额、成本、DoS

- 已覆盖（按 IP 小时桶）：verify/verify-repair 120、mcp **HEAD 0**→工作区 120、plan-check 120、plan-repair 30、refine 20（线上 8）、chat 40（线上 12）、extract 10、adjust 60、candidates 60、replan 60、restore 60、map 600（线上 300）、places 600（线上 300）、geocode 120（线上 60）、weather 120（线上 60）、events 300。全局闸门：生成 2 并发/40 日、LLM 2 并发/150 日（`render.yaml:48-74`）。
- **缺口**：`/api/mcp`（HEAD，R2）、海报/OG（R6）、`/p|/t|/w|/r` 页面（每请求重跑引擎/凭据，未限流）、`/api/plan/status`、`/api/plan/ics`；verify/mcp/plan-check/repair/poster **无全局并发或 CPU 闸门**（`lib/capacity-gate.ts` 只服务生成/LLM）。
- body 上限：仅 verify/repair/mcp 256 KiB（`app/api/verify/route.ts:40,71-73`；mcp HEAD:27,73-79）；其余 12 处裸 `req.json()`（R1）。工作区已给 check/repair 加 16 KiB，但 refine/restore/chat/extract/clone/adjust/candidates/replan/events/auth/plan 仍未覆盖。
- 全局闸门是**进程内**状态（`lib/capacity-gate.ts:12-22`）：多实例=每实例上限，且重启清零（R7 同源）。
- 生成侧顺序正确：先占并发槽→预扣日预算→建任务，失败退还（`app/api/plan/route.ts:209-253`）。

### 2.4 输入与注入

- 进 prompt 的自由文本均有字符白名单：city/preferences/hotel/mustVisit/cities/events（`app/api/plan/route.ts:27-129`）、profile 复用 `lib/profile.ts`；refine 指令白名单且 fix 指令由服务端模板生成（`refine:63,185-211`）；copilot 单条 ≤500 字（`chat:38-41`）、extract 20–4000 字（`extract:24-27`）。仍有「模型被说服」的内容层风险（copilot/extract 是开放文本进 prompt），但**无工具调用/无写权限**，影响限于回答内容。
- 渲染注入：全仓仅 1 处 `dangerouslySetInnerHTML`，内容为 `jsonLdScript()` 输出且已把 `<` 转义为 `\u003c`（`lib/verify/jsonld.ts:69-77`、`app/(app)/p/[id]/page.tsx:144`）；海报走 Satori→PNG（无 HTML 执行面）；React 默认转义其余字段。
- 头部注入：`.ics` 文件名 `encodeURIComponent`（`app/api/plan/ics/route.ts:19-25`）；无用户可控 `Location` —— 除微信回调（R10）。
- SSRF：所有出口为固定上游 + 参数拼接（`lib/amap.ts:21,139-144`、`lib/staticmap.ts:118-124`、`lib/weather.ts`、`lib/auth/sms.ts:92`、`lib/auth/wechat.ts:10,27`），**未发现可指定任意上游的入口**。
- 原型污染/解析：zod 归一化后进引擎，`canonicalJson` 键排序、无递归合并；未发现 `__proto__` 合并面。

### 2.5 数据与隐私

- 事件表口径与文档一致（无手机号/IP/行程内容）：`app/api/events/route.ts:11-19,21-30`、`prisma/schema.prisma:62-83`；看板 `METRICS_TOKEN` 用 `timingSafeEqual` 且未配置一律 404（`app/api/events/summary/route.ts:21-47`）。
- 配额桶 key 含 `u:<phone>` / `ip:<addr>`（`prisma/schema.prisma:18,48-53`）——隐私页已披露「访问与配额数据：IP」（`app/(marketing)/privacy/page.tsx:34`），口径一致；但 postgres 中属于明文 PII，建议文档标注保留期（当前按日清理靠 `memory.ts:127` 的定时器，postgres 侧仅 lazy 清理 job/smsCode）。
- 短信验证码表存 `phone+code` 明文、5 分钟 TTL、一次性（`lib/auth/sms.ts:112-119`、`memory.ts:105-120`）——可接受，建议 code 加 pepper 或哈希（低成本）。
- 计划存储：`Plan.input` 含 profile（体力/忌口/作息，可能属健康相关偏好）与 hotel/events；postgres 无 TTL（`lib/store/postgres.ts:39`）——属产品资产，但应在隐私页明确「行程与偏好长期保存、删除入口」。
- 日志：`console.*` 共 62 处，抽查为 city/shareId/耗时/tokens/错误原因，无手机号/密钥；唯一例外是 dev provider 打印手机号+固定验证码（`lib/auth/providers.ts:19`，仅非生产）。
- 索引：robots 禁止 `/p/ /t/ /w/ /r/ /api/`（`app/robots.ts:13-18`）、sitemap 不含私页（`app/sitemap.ts:32-46`）；但无 `X-Robots-Tag`/`noindex` meta（R13），线上分享页 0 个 robots meta。
- PWA：SW 只缓存 `/t/`、`/p/` 导航（`public/sw.js:45-58`），忽略 HTTP 缓存头 → 私有行程离线副本永久留在设备 CacheStorage（R13）。

### 2.6 出口、秘密、健康检查

- 客户端：`.next/static` 无 `.map`、无 `AMAP_*`/`LLM_*`/`sk-` 字符串（本地构建产物 grep 为空）；`NEXT_PUBLIC_` 只有 `NEXT_PUBLIC_SITE_URL`。生产 URL 由 `lib/staticmap.ts:117` 注释与实现保证 key 不出服务端。
- 仓库：`.env` 从未提交（`git log --all -- .env` 为空）；`.gitignore` 含 `.env`；gitleaks 全历史扫描 + 精确 fingerprint 忽略（`.gitleaksignore`）；CI 有 secret-scan job。
- `/api/health` 暴露 store/commit/capacity/llmConfigured/amapMode（`app/api/health/route.ts:41-58`）——部署自证需要，接受（Info）。
- 错误响应：路由普遍回通用文案、上游错误码只进日志（如 `app/api/map/route.ts:102-107`）；未发现把上游响应体透出。
- 日志中 `shareId`（能力凭据）与 city 会进日志——运维需要，建议日志轮转/访问控制（Info）。

### 2.7 Web 安全头（2026-10-28 20:00 CST 生产实测）

- 已有：`CSP`（`script-src 'self' 'unsafe-inline'`、`style-src 'unsafe-inline'`、`frame-ancestors 'none'`、`base-uri/form-action 'self'`、`img-src 'self' data:`）、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`。
- 缺失：`Strict-Transport-Security`、`Cross-Origin-Opener-Policy`、`Cross-Origin-Resource-Policy`、`X-DNS-Prefetch-Control`；HTML 响应带 `X-Powered-By: Next.js`。
- 私页缓存头正确：`/p/<id>`、`/p/<id>/check`、`/verify` 均 `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`；`/` 为静态 `s-maxage=31536000`（预期）。
- CSP `'unsafe-inline'` 是 Next hydration/framer-motion 的现实约束（`next.config.ts:24-45` 已记录理由）；当前唯一 HTML 注入 sink 已转义，故列为取舍（Info），后续有 nonce 需求再收。
- 实测命令：`curl -sS -o /dev/null -D - https://travel-planner-demo.onrender.com/{,verify,api/verify,p/share_Z5oYam8ahjqb,p/share_Z5oYam8ahjqb/check}`；`OPTIONS /api/verify` → 204 + `Access-Control-Allow-Origin: *`；`POST /api/verify`（合法 1 天文档）→ 200 + `credential.id=tc_…` + `X-Trip-Check-Spec`，无鉴权、无写库（响应 `document.days/spots` 为计数，无回显内容）。

### 2.8 依赖

- `npm audit --omit=dev`：**6×moderate**，全部来自 `fast-uri`（4 条 advisory）经 `ajv → @prisma/streams-local → prisma/@prisma/client` 链；**当前无 fix available**。生产运行时风险低（校验/工具链路径），CI `npm audit --audit-level=high` 不阻断。
- 建议：订阅 prisma 上游更新（升级 prisma 7.x 后重跑 audit）；不为此改 lockfile/换依赖；在 CHANGELOG 记一条已知 moderate。Next 16.4.2 / React 19 无已知 high。

### 2.9 部署与 CI

- `render.yaml`：free/singapore、`/api/health` 健康检查、buildCommand 与 DEPLOY 裸机路径一致；**未设 `DATA_STORE` → memory**、`DEMO_SEED=1`、费用闸门齐全（40/150/2/2 与各 IP 桶收缩）、`METRICS_TOKEN generateValue`、`TRUSTED_PROXY_HOPS=1`、`SESSION_SECRET sync:false`（建议 `generateValue:true`，当前登录本就 disabled）。
- buildCommand **不跑** `check:env/preflight`（`render.yaml:21-27`）→ 仓内「生产必须 postgres / SESSION_SECRET 不能默认」的 BLOCK 不会在部署时执行；线上 auth 因误配 fail-closed 关闭（正确行为），但 memory 配置无告警（R7）。
- `TRUSTED_PROXY_HOPS=1`：线上同时有 Cloudflare 与 Render 反代（响应头 `server: cloudflare` + `x-render-origin-server`），**取到的 XFF 右侧第 1 个是否=真实客户端未验证**（§5）。若取到边缘 IP，后果是把大量用户归并进同一限流桶（更严而非更松），但会让「按 IP 配额」语义失真。
- CI：`ci.yml` 四门齐全 + `test-postgres` + gitleaks 全历史；缺 `permissions:`（R15）；无部署 workflow（Render 自动），无密钥引用（secrets 仅在 Render Dashboard）。
- 保活：`keep-warm.yml` 每 5 分钟 ping `/api/health`（`permissions: {}` 已最小化）；750h/月上限接近 730h 需求，属演示取舍。

### 2.10 Trip Check 新公开面

- `/api/verify`（GET 元信息/POST/Schema/OpenAPI/OPTIONS）：无鉴权 + CORS `*` + 不写库 + 256 KiB + 120/h/IP——**开放标准的前提，接受**。实测 200 报告无内部信息泄漏；credential 为确定性哈希（`lib/verify/credential.ts:19-27`），**不是签名**，文档已诚实声明（`docs/TRIP-CHECK-STANDARD.md`、凭据 `basis` 字段），不构成认证凭据。
- `/api/verify/repair`：同上限流、不写回（`persisted:false`），只做机械变换——接受。
- `/api/mcp`：HEAD 无鉴权/无限流（R2）；`verify_shared_trip` 的 `shareId` 只校验长度 1–64（`lib/verify/mcp.ts:177-196`），因此也接受旧 jobId（经 `resolvePlan` 兜底）→ 与开放 API 的 `share_` 前缀限制（`lib/verify/validate.ts:119-123`）不一致，建议 MCP 同口径收紧到 `^share_`。
- 报告页/海报枚举：share token 72 bit（`lib/plan-repo.ts:38-40`），枚举不可行（Info，足够）；`/p/<unknown>` 返回 200「链接已失效」页（软 404，反向有利于防枚举）；报告页/海报对不存在 id 返回 404（实测 `/p/job_zzzz` 页面 200、`/api/plan/status` 404）。
- 凭据可作为「认证」？否：`credential.id` 只证明「某份文档在某口径下的判定可复算」，任何人都能对任意文档算出凭据；不得用于鉴权（文档已声明，本审计确认实现一致）。
- 公开面新增的滥用成本：verify/repair 每次 CPU 代价随文档规模（上限 30 天×200 点，`lib/verify/types.ts:38-44`）线性，受限流保护；**海报/OG 是真正未受保护的 CPU 放大点**（R6）。

## 3. 建议本轮先修的 3 件

1. **统一 body 上限 + 公开 CPU 面闸门**（消 R1/R6，并为 R2 收尾）：把 `lib/http-body.ts::readJsonBody` 铺到剩余 12 个裸 `req.json()` 端点（普通 16–64 KiB；verify/mcp 保持 256 KiB）；给 verify/mcp/plan-check/repair/海报/OG 加一个共享的「进程内并发 + 每 IP 每小时」CPU 闸门（可直接复用 `capacity-gate.ts` 的模式）。
2. **收紧 jobId 能力与旧链接读回**（消 R3）：`lib/jobs.ts:177` 改用 `crypto.randomBytes(16)`；`/api/plan/status`、`/api/plan/ics` 加按 IP 限流；生产 `DATA_STORE=postgres` 模式下关闭 `resolvePlan` 的 job 兜底（或仅在 `DEMO_SEED`/memory 演示模式保留）。
3. **让「可信证据」不可被客户端伪造**（消 R4/R5）：去掉 demo 行程的写权限（seed 记录加 readOnly 标记 → refine/restore/repair 403）；`restore` 落库前剥离 `tripCheck/verification/verified/warnings` 并服务端重算（`stampPlan`/`refreshTimeWarnings` 已有现成实现），拒绝把客户端自报的「已核验/已修复」渲染到分享页。

## 4. 已接受 / 设计取舍（本轮确认，不重复报）

1. **分享 token 即能力（共编）**：ADR-014 与 API.md 明示，用「不可猜测 token + 无鉴权」换取分享/共编零摩擦；若未来做多用户，需独立编辑凭据（R4 的根因仍是 demo token 公开，不是模型本身）。
2. **`/api/verify`、`/api/mcp` 无鉴权 + CORS `*`**：开放标准/MCP 客户端的必要前提；已有限流（MCP 在工作区）+ 不写库 + 不调模型。
3. **credential 是确定性哈希而非签名**：`lib/verify/credential.ts:19-27` 明确「只保证可复现、可对账」，文档/海报均标注「可复算 · 不是数字签名」。
4. **演示站 memory + DEMO_SEED + 休眠丢数据**：DEMO.md 已说明是公开演示取舍；真实上线必须 postgres（check:env BLOCK 同口径）。
5. **`/api/health` 暴露 commit/store/capacity**：部署自证与运维需要，不含用户数据。
6. **CSP `'unsafe-inline'`**：Next hydration/framer-motion 现实约束 + 输入白名单 + 唯一 sink 已转义；列为待收紧项。
7. **公开页软 404（无效分享链接返回 200）**：故意不向匿名者区分「id 不存在」，对防枚举有利。
8. **无登录（生产 auth disabled）**：fail-closed 正确；登录链路只有开发/未来商业版使用。
9. **限流是内存态、重启即清、多实例各自为政**：`lib/capacity-gate.ts:12-22` 已注明，单实例演示可接受。

## 5. 未验证清单（诚实标注，勿当作已排除）

- **XFF 取信在 Cloudflare→Render 两跳下是否取到真实客户端**：需一次受控实验（不可在没有流量影响的情况下观察限流键），本轮未做；逻辑上只会更严不会更松。
- **Math.random 可预测性可否实际推出他人 jobId**：仅能证明熵≈20.7 bit 且非 CSPRNG，未做状态恢复实验。
- **生产 body 上限**：Render/Cloudflare 对请求体的硬限制未实测（遵守只读、不做压测）；代码侧确认 App Router 无默认上限。
- **R4 演示行程可写**：由代码路径（`getPlanForEdit` 对 seed Plan 返回记录 + `/api/plan/restore` 接受任意合法 Plan JSON）判定，**未在生产实际写入**（任务禁止）。
- **R9 撞码**：仅在 `AUTH_PROVIDER=sms` 时可利用；当前线上 disabled，未验证真实短信链路的账号接管。
- **CI/GitHub 仓库设置**（默认 token 权限、分支保护、Dependabot）未读取远端设置，仅按文件判断。
