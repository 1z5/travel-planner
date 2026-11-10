# ADR-019: 从「技术展示」回到「自己每天用」——双入口上线与手机优先

## 状态

已接受（2026-11-10；主站持久化、静态验真台、手机端改造均已落地）

## 背景

ADR-017/018 把项目定位写成了「个人开源技术展示」，并顺着这个定位在 README、
DEMO.md、ARCHITECTURE.md 里写下了「不承诺可用性」「演示站休眠、重启丢数据」
「存储是 memory」等口径。这是**对需求的一次误读**：

> 「我前面说的可以给自己用，不代表不用上线；我希望不光是在本地用，我在手机上也希望能用。」

也就是说：它既是 GitHub 上的作品，也是作者自己每天要打开的工具。一个「重启就丢行程、
手机首次打开要等 60 秒冷启动」的东西，不满足这个要求。具体问题：

1. `render.yaml` 用默认 memory store：实例休眠/重启后，用户自己生成的行程和分享链接全丢；
2. Render 免费 Web Service 15 分钟无请求休眠，冷启动 30–60 秒，手机随手打开不可接受；
3. 离线验真台（ADR-018）是桌面布局：980px 容器、窄屏按钮被挤、结论要滚过一整屏 JSON；
4. 没有「添加到主屏 / 断网打开」的能力，手机上不像个能顺手用的工具；
5. 想加数据库时有个陷阱：**Render 免费 Postgres 创建 30 天后过期**，14 天宽限期后
   连数据一起删除且无备份（官方文档口径）。把它写进 Blueprint 等于埋一个定时清空。

## 决策

1. **双入口，按「需不需要服务端」分工**：
   - **手机日常入口 = 纯静态验真台**。`.github/workflows/pages.yml` 把
     `public/verify-playground.html` 发成 GitHub Pages 静态站：没有实例、不休眠、
     不依赖数据库/LLM/高德 key、页面 CSP 关闭一切出站请求，断网也能算。
     同时保留一个随时可用的托管入口（WorkBuddy App Publishing）。
   - **主站 = 需要服务端的能力**（生成、持久化、分享、行中模式），继续跑在 Render，
     由 `keep-warm.yml` 每 5 分钟保活。两个入口互不依赖：主站挂了，手机上的验真照用。
2. **主站持久化改成外部不设过期的免费 Postgres**（Neon / Supabase 免费层）：
   `DATA_STORE=postgres` + `DATABASE_URL`（`sync:false`，不进 Git）+
   `preDeployCommand: npx prisma db push --skip-generate`。
   代码侧 `store/postgres.ts` 与 schema 早已存在，不改应用逻辑。
   **不填连接串就部署失败**，绝不静默退化成 memory 假装「已保存」——沿用项目
   「不猜、不假装」原则。Render 自带免费 Postgres 明确不采用，理由写入 render.yaml 注释。
3. **验真台移动优先**（用真实 390×844 设备模拟验收，不是靠猜）：
   - 单列卡片、≥44px 触控目标、`overflow-wrap:anywhere`、无横向溢出；
   - 点完立刻把结论滚到首屏（延到下一帧，避开浏览器锚点定位覆盖）；
   - 「改文档 / 复制凭据 ID」大按钮；
   - 内联 data-URI manifest + iOS/meta，可「添加到主屏」全屏启动；
   - 同源 SW 缓存导航文档，断网可打开。注册时用**窄 scope**
     （页面挂在 `/verify-playground.html` 时），避免和主站 `/sw.js` 的 root scope 抢控制权。
4. **叙事改正**：README / DEMO / ARCHITECTURE / DEPLOY 里所有「重启丢数据、
   不承诺可用性、memory 存储」的过时口径全部替换成现在的真实架构；
   仍如实保留「免费实例会休眠」「无错误监控」等边界。

## 验证口径（手机）

Chrome headless 的 `--window-size` 最小视口是 500 CSS px，直接截图会把
500px 的布局裁成 390px 的图，看起来像「溢出」。验收必须用 CDP
`Emulation.setDeviceMetricsOverride({width:390,height:844,deviceScaleFactor:2,mobile:true})`：
实测 `scrollWidth === innerWidth === 390`、无越界元素、按钮高度 44–49px、
manifest 存在、结论区自动滚动（`scrollY=624`）、凭据 ID `tc_46031b87…` 一致。

## 后果

- 作者手机上有了两个真正能用的入口：秒开的验真台（可装到主屏、离线可用），
  以及数据不会丢的主站。GitHub 访客也多了一条不依赖 Render 是否活着的路径。
- 多了一个外部依赖（Postgres 连接串）和一个开关（GitHub Pages 需手动启用一次）。
  两者都在 DEMO.md 写清楚了，失败时是响亮的失败而不是静默降级。
- SW 的 scope 判断变复杂了一点：这是「同一个 HTML 既能在 Next 站、又能在静态站、
  还能双击打开」必须付的代价，已用注释固化在模板里。

## 仍未做

不做账号体系（分享 token 即能力，个人使用够）；不把生成搬到 serverless
（3–10 分钟长任务需要常驻进程，见 DEPLOY.md）；不强制付费升级 Render Starter，
只为「主站零冷启动」时才需要，静态入口已经把手机场景的冷启动问题绕开了。
