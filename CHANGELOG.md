# 变更日志

记录这个项目从 0 到「可上线就绪」的关键工程决策。倒序（新→旧），每条都是实测踩坑后的结论。

## 2026-10 大版本升级轮：依赖现代化 + 遗留清理 + 分享增强

一次性把技术栈推到当前最新稳定版，并处理升级暴露的问题。每个大版本单独提交、单独验证，出问题能独立回滚。

**依赖升级**（均在 semver 内或按大版本迁移指南）：
- openai 5 → 7：lib/planner.ts 的流式用法无需改动；v7 的 peer 是 zod "^3.25 || ^4.0"，是 zod 4 的前置
- zod 3 → 4：被 openai v5 的 peer 锁死，升 openai 后才走得通；用法全是基础 API，无代码改动
- Prisma 6 → 7：破坏性变更——schema 不再支持 datasource.url。拆成 prisma.config.ts（CLI 连接）+ PrismaClient 传 driver adapter（运行时连接）
- Next 15 → 16：项目已用 async params，无需迁移代码
- typescript ^5.6.0 → ^5.9.3

**TypeScript 7 实测不可用**（记录过程避免重复踩）：TS7 已发 latest，但它是「JS 薄封装 + 平台原生二进制」结构，`ts.sys` 是 undefined。装上新诊断 TS2882（layout.tsx 的裸 CSS 导入报错，根因是 next/types 只声明 *.module.css），但决定性障碍是 `next build` 加载 next.config.ts 时直接崩溃——Next 15.5 需要 ts.sys.fileExists。结论：等 Next 16+ 级别的支持后重试。

**Prisma 7 引入的 client 生成缺失回归**（验证 OG 图时暴露，比 OG 图本身严重）：dev server 运行时崩 `Cannot find module '.prisma/client/default'，且 DATA_STORE=memory 默认路径也崩（postgres 模块是静态 import）。根因：Prisma 7 起 @prisma/client 的 package.json 里没有 postinstall 了，client 生成完全依赖显式 prisma generate，而 CI/Dockerfile/preflight 三处都没有这一步——任何全新安装必崩。已实测复现（rm -rf node_modules/.prisma 后 typecheck 立刻报错）。修复：Dockerfile 与 ci.yml 补 `npx prisma generate`（只读 schema 不连库，实测无需 DATABASE_URL），preflight 新增 BLOCK 级检查。

**跨大版本升级的假故障**：Next 15→16 后首次 build 在预渲染 "/" 时报 Server Components render error + digest，生产构建还刻意隐藏真实信息。起 dev server 验证首页却 200 正常。真正原因是 .next 里残留了 Next 15 的产物——rm -rf .next 后一次通过。教训：跨 Next 大版本必须先清 .next。

**分享页动态 OG 图片**：新增 app/p/[id]/opengraph-image.tsx，用 next/og 生成「城市 + 天数 + 概览 + 预算/行程点」卡片图，视觉对齐 globals.css 的深色 Premium 设计系统。已验证 og:image 与 twitter:image 都正确注入（1200×630 PNG）。两个 Satori 硬约束：多子节点的 div 必须显式 display:flex（判据是 children 非字符串，数字/表达式都算）；不支持 -webkit-line-clamp，摘要改 JS 截断。中文无需自带字体——实测 Satori 回退系统 CJK 字体正常渲染。

**死 CSS 清理**：删掉设计系统 v2→v4 迭代遗留的 7 个无人引用的选择器（.result-head/.result-dates/.result-summary/.result-actions/.pill 系列，共 16 行）。

验证：typecheck / 50 单测 / 124 e2e / 生产构建 / npm audit 全绿。

## 2026-10 健壮化迭代：高德三态 / LLM 结构核对 / 依赖与前端加固

**高德三态（本轮最重要的修复）**：原来 `amapGet` 没有 try/catch，且把「网络异常/上游错误码」和「高德明确说没有这个 POI」混为一谈（都返回 null）。后果：key 失效、QPS 超限、网络抖动时，`validate.ts` 会把一堆**真实存在**的景点标成「未在高德检索到」——预警系统自己变成谎言，正是本项目最怕的事故（与当年的 MOCK 假通勤同类）。改为三态 `hit / miss / error`：

- 只有 miss 触发「未检索到」预警；error 只汇总成一条系统提示，并让徽章显示「部分未能验真」（`plan.verification="partial"`）
- 通勤一端解析失败归为 error 时返回 `unknown`，**跳过**该天的通勤与节奏判定——拿拍脑袋数字参与「绕路预警」和「节奏体检」会同时污染两个指标（原实现给 30 分钟保守值，看似稳妥实则制造假数据）
- 瞬时失败（网络异常 + QPS 类错误码）指数退避重试 3 次；非瞬时错误（key 无效/平台不匹配）不重试，并按内容去重日志，否则它只表现为「一堆景点未能验真」而没人知道根因是配置
- error 结果按 10 秒短 TTL 缓存：服务抖动时同一地名（住所每天都出现）会被反复解析几十次，不缓存等于把已经挂掉的服务再打一遍
- 验真/通勤改有界并发（`lib/concurrency.ts` 的 `mapLimit`，5 路）：一次 4 天行程约 25 个 POI + 20 段通勤，串行要多等十几秒；并发度固定又不会打满个人 key 的 QPS

**LLM 输出结构核对**：`PlanSchema` 只校验「day 是 number」，模型少排一天、排个空天、day 编号乱序/0 基/跳号都能通过 zod 并直接渲染成错乱行程。新增 zod 之外的语义层：按 day 排序并重编号为连续 1..N；核对天数是否等于请求天数、每天是否至少 1 个行程点、是否有主题。不符时把**具体原因回灌进 prompt** 重试一次（比原样重试更可能救回来），仍不符则明确报错并退还配额——不把 3 天行程冒充成 4 天交付。

**依赖安全（CI 红灯）**：`npm audit --audit-level=high` 报 3 个 high——deepmerge-ts <8（CVE 栈耗尽）经 `@prisma/config` 进入 prisma CLI，而 CI 正好有道审计门。用 `overrides` 固定 `^8.0.2`：先对比两版导出确认 v8 完整保留 v7 的 `deepmerge`，且 `@prisma/config` 只 import 这一个符号，再实测 `prisma validate` / `prisma generate` 均正常。顺带在 semver 内做补丁升级（next 15.5.28 / react 19.3.1 / lucide 1.57 / vitest 5.0.4）。

**`.ics` RFC5545 修正**：行折叠原来按**字符**数（73），而规范要求 75 **字节**——中文在 UTF-8 下占 3 字节，一行实际可达 200+ 字节，严格的日历客户端（部分 Outlook 版本）会拒收整个文件。改为按字节累计折叠且不在多字节字符中间下刀。另修两处：跨零点时段（23:00-01:00）的 DTEND 未顺延一天（结束早于开始，事件被丢弃）；UID 不含 spot 身份（两份同城同日起点的行程导入同一日历会互相覆盖）。

**前端**：轮询以前只认 done/error——任务 404（服务重启/超过 2 小时 TTL）时 `data.status` 是 undefined，于是永远每 3 秒转一次圈。补三件套：404 立即报错、单次网络抖动重试 3 次（3 分钟的等待不该被一次抖动毁掉）、15 分钟总超时，外加卸载后停止轮询。无障碍：chip 原是 `span+onClick`，键盘完全无法选择城市/偏好，补 role=button + Enter/Space；label 与 input 补 htmlFor/id 关联；等待提示与错误提示补 aria-live。**注意**：秒表文字每秒变化，不能加 live，否则读屏器会被刷爆。

**首页服务端/客户端边界（实测发现的坑）**：营销/FAQ/页脚是零交互静态内容，却因整页是 client component 而被打包 hydrate。抽成 `landing-sections.tsx` 后**包体一度没变**——grep 发现静态文案仍在 `.next/static/chunks/app/page-*.js` 里，证明 client component **直接 import** 的模块仍会进客户端包，只有 children 传递才是真正的边界。改为 `page.tsx`（服务端外壳）→ `home-client.tsx`（客户端表单）+ children 传入静态区块后，文案确认离开客户端包，`/` 路由 9.99 kB → 8.06 kB。

**测试补强**：新增 50 条 Vitest 单测（此前纯逻辑层零覆盖）+ 11 条 e2e（乱序归一化 6 + 天数不符 5）。为了让单测能 import 带 `import "server-only"` 的服务端模块，用 `vitest.config.mts` 的 resolve.alias 把 `server-only` 指到仓库内空桩（没有硬编码 next 的内部路径，升级 Next 时不会漂）。踩坑记录：高德 POI 缓存是模块级状态，测试间必须用地名上唯一的输入，否则后一个测试会读到前一个测试缓存的 error（第一批 4 条失败全由此而来）。

## 2026-10 住所/必游地 + 误报修复

**功能**：用户可指定住所（全程为基地，第一晚直接用）与期望必游地（最多 5 个硬约束，漏排在体检显式告警）。

**真实 case 揪出的核验 bug**：住所校验原本用全字符串匹配——用户说「住春熙路附近」时模型正确转化成「春熙路亚朵S酒店」，却因匹配不到原文而**误报**「未体现」。修复：提取场所核心词（剥离 住/附近/酒店 等口语词）双路匹配。**教训：核验逻辑要考虑输入的模糊性，否则预警系统自己变成谎言**（與 MOCK 假通勤同类）。

**首次真实模型验证（成都 4 天，三星堆+都江堰+住春熙路）**：两个必游地都被正确安排为全天（高铁/城际衔接精确），住所语义完美执行，预算贴合 90%。prompt 的硬约束规则真实有效。顺带发现 4 天行程天天「偏满」——阈值 10h/天与模型输出密度处于边界，属预期行为。

## 2026-10 可上线就绪状态

**部署与运维**
- `npm start` 与 `output: standalone` 不兼容，必须 `node .next/standalone/server.js`；standalone 不读 `.env`，环境变量必须显式注入
- 新增 `npm run preflight`：部署日 GO/NO-GO 自检（Node 版本/密钥/密钥默认值/高德模式/配额/.gitignore/构建产物）
- `/api/health` 探针 + 成本模型文档（配额即成本闸门）

**正确性修复**
- **LLM 改流式**：非流式撞 undici `headersTimeout`（默认 300s，比 SDK 420s 先炸），推理模型 3-5 分钟生成间歇被杀。流式后消失，顺带获得真实 usage
- **双轨配额 remaining 实时计算**：原快照在失败路径不刷新（用户看到错误剩余数）
- **SDK 超时要配 `maxRetries: 0`**：实测 timeout 按「尝试次数 × timeout」才抛（30s 超时 91s 才报）
- **预算 prompt 用锚点不用计算题**：百分比分配规则让 reasoning 从 ~1.3 万涨到 4 万+字符，生成 250s→600s+ 超时；改「晚均价按预算档位取 250-500」后恢复
- **dev 模块多实例**：jobs Map / 配额 Map / 窗口 Map 三度因模块级状态在请求间丢失，全部改挂 globalThis（跨 HMR、跨路由编译实例共享）

**范围决策**
- 天数收紧为 3-4 天：实测 5 天单次生成必爆 token（跑满 16 分钟仍超时）
- 「大纲+分日并行」提速尝试证伪（320s > 单次 253s），单次调用 + 异步任务模式胜出

## 功能建设

**M3 登录体系**：provider 抽象（none/sms/wechat）；自签 HMAC session cookie（7 天，零依赖）；双轨配额（IP 3 次/天、用户 10 次/天，IP 限流不影响登录用户）；短信防轰炸（单号 5/h、单 IP 20/h）；微信 OAuth2 全流程（state cookie 防 CSRF、防开放重定向、code→openid→session）。

**M1-M2 核心**：step-5 zod 约束生成结构化行程；高德按官方文档集成（`/v3/place/text` 验真 + `/v5/direction/driving` 通勤——**距离接口只收坐标，地名必须先解析**，且 v3/distance 已不在文档内）；体检治理（绕路/节奏/预算/未验真）；异步任务（202+轮询+秒表+失败退还）。

**框架坑记录**：Next 重定向是 307 不是 302；手动 `headers.set("Set-Cookie")` 与 `cookies.set()` 混用会丢 cookie；route 文件导出非 HTTP 方法/配置会构建失败（type error 藏在 build 阶段，管道 tail 会吞退出码，必须 `set -o pipefail`）。

## 测试体系

66 条自包含断言（`npm test`）：输入边界 14（含 prompt 注入用例）+ 故障注入 5 + 高德集成 9（官方 API 形状）+ 登录 36（含微信 OAuth 15）。三套桩服务（LLM/高德/微信）让故障与集成测试秒级完成。真实生成 6 case 回归（西安/苏州/成都/杭州/厦门，prod standalone 亦验证）。
