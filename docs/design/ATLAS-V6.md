# ATLAS v6 — 活地图（Living Atlas）前端设计语言

> 状态：2026-10-29 起实施。取代 v5.1「纸上行程 · 企业级精度」。
> 实施原则：**旧 CSS 全部保留**（`app/globals.css` 不动），v6 以「覆盖层」形式叠加在
> `app/styles/atlas-*.css`，按 import 顺序后写者胜。所有既有 class 名与文案保持不变。
>
> 验收口径：`npm run gate:visual` 必须全绿；组件测试（querySelector 依赖的 class）不能被删。

---

## 0. 一句话

**行程不是一篇文章，是一台能读的仪器。** v6 把「纸面杂志」升级为「测绘仪器 × 杂志排版」：
产品界面（首页 / 工作台 / 体检）是仪器——深空墨底、极光、玻璃面板、等宽数据；
分享页 / 报告页是**旅行刊物**——衬线大标题、留白、可打印。两者共用一套 token 与动效语言。

三个可感知的差异：

1. **双主题**：Daylight（冷瓷白 + 珊瑚 + 潟湖青）/ Nocturne（深空墨 + 极光 + 荧光珊瑚），
   跟随系统 + 手动切换（圆形 View Transition 揭示）。
2. **材质**：玻璃面板（backdrop-blur + 1px 渐变高光边）+ 极光背景 + 2% 颗粒噪点 +
   显微网格；层级靠「光」与「玻璃」而不是阴影堆积。
3. **动效**：View Transitions（跨路由共享元素 + 镜头切换）+ 滚动驱动揭示
   （`animation-timeline: view()`）+ 弹簧微交互；全部在 `prefers-reduced-motion` 下降级。

---

## 1. Token 契约

所有颜色/半径/阴影/字体都从 `--at-*` 取；**组件 CSS 不许写十六进制颜色**（装饰性渐变除外）。

| 语义              | Token                | Daylight                | Nocturne                |
| ----------------- | -------------------- | ----------------------- | ----------------------- |
| 画布              | `--at-bg`            | `#EDF1F7`               | `#05080F`               |
| 画布深            | `--at-bg-deep`       | `#E4EAF3`               | `#0A111E`               |
| 玻璃面            | `--at-surface`       | `rgba(255,255,255,.78)` | `rgba(18,27,44,.66)`    |
| 次级面            | `--at-surface-2`     | `rgba(248,250,253,.92)` | `rgba(26,37,58,.66)`    |
| 实心面            | `--at-surface-solid` | `#FFFFFF`               | `#0C1424`               |
| 正文              | `--at-ink`           | `#0A1220`               | `#EDF2FC`               |
| 正文 2            | `--at-ink-2`         | `#26344A`               | `#C6D2E6`               |
| 正文 3            | `--at-ink-3`         | `#4C5C76`               | `#93A4BF`               |
| 正文 4            | `--at-ink-4`         | `#5E6F8A`               | `#7E90AC`               |
| 细线              | `--at-line`          | `rgba(10,18,32,.10)`    | `rgba(255,255,255,.10)` |
| 强线              | `--at-line-2`        | `rgba(10,18,32,.20)`    | `rgba(255,255,255,.22)` |
| 强调（文字/填充） | `--at-accent`        | `#C73310`               | `#FF7C57`               |
| 强调（装饰）      | `--at-accent-vivid`  | `#FF5E33`               | `#FF8F6B`               |
| 强调柔光          | `--at-accent-soft`   | `rgba(199,51,16,.08)`   | `rgba(255,124,87,.12)`  |
| 次强调（潟湖青）  | `--at-teal`          | `#0A7A72`               | `#45DCC6`               |
| 三强调（电紫）    | `--at-violet`        | `#5142C9`               | `#A48CFF`               |
| 成功              | `--at-ok`            | `#0B6B4F`               | `#52D98F`               |
| 警告              | `--at-warn`          | `#8A5300`               | `#F0B24A`               |
| 危险              | `--at-err`           | `#A81F16`               | `#FF7B72`               |

对比度（WCAG AA，实测）：Daylight `ink-3` 5.8:1、`accent` 白字 5.37:1、`ink-4` 4.6:1；
Nocturne 全部 ≥ 5:1。**新增文字颜色必须实测 ≥4.5:1（大字号 ≥3:1）**，并加入
`scripts/visual-check.mjs` 的 `CONTRAST_SELECTORS`。

形状与光影：

```css
--at-r-sm: 8px;
--at-r-md: 14px;
--at-r-lg: 20px;
--at-r-xl: 28px;
--at-r-pill: 999px;
--at-shadow-sm: 0 1px 2px rgba(10, 18, 32, 0.06);
--at-shadow-md: 0 1px 2px rgba(10, 18, 32, 0.05), 0 12px 32px rgba(10, 18, 32, 0.09);
--at-shadow-lg: 0 2px 8px rgba(10, 18, 32, 0.06), 0 32px 80px rgba(10, 18, 32, 0.14);
--at-glass-edge: inset 0 1px 0 rgba(255, 255, 255, 0.55); /* 玻璃上缘高光 */
--at-glow: 0 0 0 1px var(--at-accent-ring), 0 12px 40px -8px var(--at-accent-glow);
```

字体：产品界面用系统中文无衬线（PingFang SC）大字号 + 紧字距（`-0.02em`）；
数据用等宽（`--at-mono` + `font-variant-numeric: tabular-nums`）；
刊物面（`/p/`、`/r/` 的海报与报告）沿用宋体衬线（`--at-serif`）。

```css
--at-sans: "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", -apple-system, …;
--at-mono: "SF Mono", "JetBrains Mono", "Menlo", …;
--at-serif: "Noto Serif SC", "Songti SC", serif;
```

---

## 2. 材质配方（可直接抄）

```css
/* 玻璃面板 */
.at-glass {
  background: var(--at-surface);
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  border: 1px solid var(--at-line);
  border-radius: var(--at-r-lg);
  box-shadow: var(--at-shadow-md), var(--at-glass-edge);
}
/* 极光背景：body::before 已提供，页面不要重复铺满屏渐变 */
/* 显微网格：section 级装饰 */
.at-grid-bg {
  background-image:
    linear-gradient(to right, var(--at-line) 1px, transparent 1px),
    linear-gradient(to bottom, var(--at-line) 1px, transparent 1px);
  background-size: 56px 56px;
  mask-image: radial-gradient(70% 60% at 50% 0%, #000, transparent);
}
```

现有 class 的语义映射（覆盖层直接改这些，不新增 wrapper）：
`.card`→玻璃面板；`.btn`→玻璃按钮；`.btn-primary`→珊瑚渐变主按钮；
`.eyebrow`/`.legend`/`.trips-eyebrow`→等宽眉题 + 前导方点 + 尾部长细线；
`.muted`/`.helper`→ink-3；`.type-badge`/`.poi-chip`→玻璃胶囊；
`.day-head`→大号 Day 数字 + 等宽元信息。

---

## 3. 动效规则

- 缓动：`--at-ease-out: cubic-bezier(.16,1,.3,1)`、`--at-ease-spring: cubic-bezier(.22,1.4,.36,1)`；
  时长 160/280/480ms。禁止 `linear`（除极光漂移、进度环）。
- 滚动揭示：只在 `@supports (animation-timeline: view())` 且
  `@media (prefers-reduced-motion: no-preference)` 内启用；初始态必须可见（防旧浏览器空白）。
- 悬停：卡片 `translateY(-2px)` + 边框提亮；按钮 `scale(.98)` 按压；均 ≤200ms。
- 跨路由：`<ViewTransition>` 只用于「同一对象延续」（首页行程卡 → 工作台标题）。
- 镜头切换：React 19.3 `startTransition` + `addTransitionType`，CSS 定义
  `::view-transition-old/new(.at-lens)` 交叉淡入 + 4px 位移。
- 主题切换：`document.startViewTransition` 圆形揭示（不支持则直接切换）。
- 数字：评分/计数用 `tabular-nums`，变化时 300ms 内滚动到位（可选实现，不做也行）。
- `prefers-reduced-motion: reduce` 时：关闭极光漂移、滚动揭示、位移；仅保留透明度变化。

---

## 4. 分片与文件所有权

| 片          | 文件                                                                                                                                                                                                                                                                                                                                                                                       | owner                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 核心层      | `app/styles/atlas-tokens.css`、`atlas-base.css`、`atlas-shell.css`、`components/ThemeToggle.tsx`、`components/AppShell.tsx`、`app/layout.tsx`、`app/globals.css` 之外                                                                                                                                                                                                                      | Lead                      |
| 首页 / 新建 | `components/TripsHome.tsx`、`app/home-client.tsx`、`app/styles/atlas-home.css`、`components/ProfileDrawer.tsx`(仅样式钩子)                                                                                                                                                                                                                                                                 | Lead                      |
| 工作台      | `components/TripWorkspace.tsx`、`components/PlanView.tsx`、`components/DayArrange.tsx`、`components/WorkspaceCheck.tsx`、`components/LiveProgress.tsx`、`app/styles/atlas-workspace.css`                                                                                                                                                                                                   | teammate：atlas-workspace |
| 证据面      | `app/(app)/p/[id]/page.tsx`、`.../p/[id]/check/page.tsx`、`app/(app)/r/[id]/page.tsx`、`app/(app)/t/[id]/page.tsx`、`components/TripCheckReport.tsx`、`components/TripCheckPlayground.tsx`、`components/TodayView.tsx`、`components/TripReport.tsx`、`components/PosterCover.tsx`、`components/ExecutabilityBadge.tsx`、`app/(marketing)/verify/page.tsx`、`app/styles/atlas-evidence.css` | teammate：atlas-evidence  |
| 营销面      | `components/SiteHeader.tsx`、`components/SiteFooter.tsx`、`app/landing-sections.tsx`、`app/(marketing)/about                                                                                                                                                                                                                                                                               | privacy                   | terms | pricing/page.tsx`、`app/(marketing)/cities/**`、`app/styles/atlas-marketing.css` | teammate：atlas-marketing |

**硬规则**

1. 只改自己表里的文件；CSS 只写自己的 `atlas-*.css`；**不要动 `app/globals.css`**。
2. 不改文案（组件测试按文字断言）；不删 class（`visual-check` 的 `required` 列表按 class 断言）。
3. 不新增 npm 依赖。服务端/客户端边界不变量：`lib/*` 不动。
4. 颜色只用 token；禁止 `#fff` 字面量（例外：海报/打印面需显式白底黑字时，加注释）。
5. 动效必须可降级；新控件触控高度 ≥40px；新增文字颜色跑对比度。
6. 提交前自测：`node scripts/visual-check.mjs --base-url http://127.0.0.1:3000`
   （15 页 × 2 视口，桌面/手机都要过）。

---

## 5. 视觉验收清单（每页都要过）

- [ ] 首屏有明确的「仪器感」元素：等宽眉题 / 坐标刻度 / 高光边 / 评分环，至少 2 个。
- [ ] Light / Dark 双主题下没有不可读文字（devtools 切 `data-theme="dark"` 目测 + 对比度脚本）。
- [ ] 移动端 390px：无横向溢出、无被裁切的主 CTA、触控目标 ≥40px。
- [ ] 滚动到页面中段仍有层级（不是一条平铺的长文档）。
- [ ] 动效在减少动效模式下不位移。
- [ ] 打印（`@media print`）：分享页/报告页仍是可读的黑白文档。

---

## 6. 实施状态（2026-10-29，全部落地）

| 层        | 文件                             | 行数  | 状态                                         |
| --------- | -------------------------------- | ----- | -------------------------------------------- |
| token     | `app/styles/atlas-tokens.css`    | ~300  | 双主题 + 旧 token 重映射 + 打印回白          |
| 基础      | `app/styles/atlas-base.css`      | ~800  | 极光/噪点/排版/原子/表单/ViewTransition/降级 |
| 产品壳    | `app/styles/atlas-shell.css`     | ~270  | 悬浮玻璃指令条 + 品牌章 + 滚动进度线         |
| 首页/新建 | `app/styles/atlas-home.css`      | ~1550 | hero + 快速开始 + 样本面板 + bento + 预检栏  |
| 工作台    | `app/styles/atlas-workspace.css` | ~2470 | HUD + 五镜头分段控件 + 时间轴仪器化          |
| 证据面    | `app/styles/atlas-evidence.css`  | ~4250 | 刊物封面 + 票根凭据 + 体检读数 + 行中        |
| 营销面    | `app/styles/atlas-marketing.css` | ~1630 | 营销壳 + about hero + 地图册页 + 法务排版    |

新增组件：`components/ThemeToggle.tsx`（三态主题 + 圆形 View Transition 揭示）、
`components/RouteTransition.tsx`（React 19.3 `<ViewTransition>` 路由转场，
`app/(app)/layout.tsx` 与 `app/(marketing)/layout.tsx` 各包一层；顶栏是持久元素、不参与动画）。

### 已知取舍（不要当成 bug 报）

1. **`app/globals.css` 一行未动**：v6 是覆盖层。好处是回滚只需删 import；代价是同一属性
   可能在两层都出现，改样式前先 grep globals 确认哪层在生效（DevTools 看 Computed）。
2. **优先级陷阱**：分片里 `.plan-view .poi-chip{min-height:24px}`（0,2,0）会盖掉 base 的
   `a.poi-chip`（0,1,1）。base 里已用 `.plan-view a.poi-chip`（0,2,1）压回去；**新增同类覆盖时
   必须确认最终 specificity**，否则触控/对比度门会莫名挂。
3. **玻璃只用于单层浮层**：顶栏、hero 面板、sticky 栏。正文列表用半透明 + hairline，
   不挂 backdrop-filter（调研：全站 Liquid Glass 可读性与低端机掉帧双输）。
4. **滚动驱动动画不藏内容**：`animation-timeline: view()` 只用于装饰（进度线、极光漂移），
   内容入场用路由 ViewTransition——因为 gate:visual 的全页截图在 scrollTop=0 采集，
   view() 隐藏法会让中下屏变成空白。
5. **暗色跟随系统**：`html:not([data-theme])` + `prefers-color-scheme`；手动三态写入
   `localStorage['at-theme']`。首帧内联脚本防闪白。headless 视觉门默认浅色，深色靠人工抽检。
6. **地图不改色**：高德底图条款不允许改瓦片样式，Nocturne 下地图仍是浅色——这是数据源
   约束，不是漏做。

## 7. 第二轮打磨（2026-10-31）

落地后逐页巡检 + 一轮联网核查（macOS/iOS 27 把「材质透明度」做成系统级滑块）后的修正，
全部记在 [../CHANGELOG.md](../CHANGELOG.md) 最新条。摘要：

| 问题                                           | 修法                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Nocturne 下高德底图像「发光窗户」（亮度 0.75） | `--at-map-filter` + veil，实测降到 0.27；**veil 必须 `z-index:1`**（底图带 filter 后会按 z-index:0 绘制，盖住 veil） |
| 新药丸壳打乱 sticky 偏移（TOC 被压、锚点被遮） | 刊物 74/136、工作台 74/136/198、手机 56/64，全部重新校准                                                             |
| 镜头条滚出 HUD 就消失                          | nav 提成 header 的兄弟节点（sticky 包含块 = 整个工作台）                                                             |
| HUD 三处重复同一个分数                         | 删 compact 徽章 → 一行可点的「N 处会影响行程 · 去体检修复」                                                          |
| 大面积 backdrop-filter                         | `.card` 去模糊；玻璃只留窄条，blur ≤14px                                                                             |
| 材质透明度是系统级可调设置                     | `prefers-reduced-transparency` / `prefers-contrast` / `forced-colors` 三个降级块                                     |

**新增硬规则**：

1. 底图类 filter 与 veil 同时用时，veil 的 z-index 必须 ≥1，SVG 覆盖层再抬一级；
2. 任何「跟随系统深色」的覆盖都要写成 `@media (prefers-color-scheme: dark) { html:not([data-theme]) ... }`——
   裸 `html:not([data-theme])` 在浅色系统下也会命中；
3. 新增长页 sticky 元素时，先量顶栏药丸底（66px 桌面 / 56px 手机），再定 top 与锚点偏移；
4. 纯位移类 hover 要能在 `@media (hover: none)` 下关掉。

### 回滚方式

删掉 `app/layout.tsx` 里 6 行 `import "./styles/atlas-*.css"` 即整体回到 v5.1；
只回滚某一片就删对应 import（注意 tokens 必须在 base 之前，删 tokens 要连 base 一起删）。
