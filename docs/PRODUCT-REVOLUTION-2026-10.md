# 产品形态跃迁 2026-10：从「会体检的行程规划师」到「行程可执行性核验层」

> 本文是 2026-10-28 全球市场重调研后的产品决策文档（执行版）。
> 上一轮蓝图（To C 产品化，见 [PRODUCT-UPGRADE-2026-10.md](PRODUCT-UPGRADE-2026-10.md)）的 S0–S4 已基本落地；
> 本轮不是再加一个功能，而是**改产品的形态与买家**。
>
> 调研证据（本轮三份，本地目录不进仓库）：`research/2026-10-global/`（R1 市场与平台迁移 / R2 竞品与用户痛点 / R3 数据与分发可行性）。
> 本文只保留结论与关键来源链接；所有链接访问日期 2026-10-28。

---

## 0. 一句话

> **别人卖「帮你生成行程」，我们卖「这条行程到底能不能走」的可复算证据。**
>
> C 端产品继续做，但角色变了：它是核验层的**展示面与试验场**；
> 真正的新形态是 **开放核验引擎 + 可对账凭据 + API/MCP 分发**——
> 让任何 AI 行程生成器（含 ChatGPT/Claude/OTA/文旅局）都能把「体检」接进去。

对外三句话：

1. **两轴结论**：结构自洽性（A/B/C/D）与事实核验覆盖（verified/partial/unverified）分开说，不拿一个总分掩盖不确定性。
2. **可复算凭据**：同一份文档 + 同一引擎/规则版本 → 同一凭据 ID，任何一方可独立重跑对账（不是营销截图）。
3. **可被调用**：HTTP API + MCP 工具 + JSON Schema/JSON-LD，零数据依赖接入；MOCK 与未核验永远显式标注。

---

## 1. 为什么必须换形态：2026H2 的五条硬事实

### 1.1 平台明确「不背责任」，责任回到供给方

- OpenAI 2026-03 关停站内结账 Instant Checkout（站内转化约为跳转零售商站点的 1/3），改为 App 交接；
  Google 的 UCP/AP2 让商家继续做 merchant of record；Claude Connectors 在预订/购买前会先跟用户确认。
  **编排归平台，责任归品牌/供给方。**（二手汇总：[awesomeagents](https://awesomeagents.ai/news/openai-chatgpt-app-integrations-launch/)、
  [PYMNTS](https://www.pymnts.com/dashboard-post/news/artificial-intelligence/2026/google-builds-cart-shops-while-you-sleep/)；
  一手：[Claude Connectors](https://claude.com/blog/connectors-for-everyday-life)）
- 供给方已经在 agent 化：Sabre MCP 近 80 家客户在试点/生产，且已在 ChatGPT/Claude 内供给
  （[Sabre 官方](https://www.sabre.com/resources/newsroom/mcp-is-the-new-ndc-is-this-travels-shift-to-streaming-moment/)）。
  **agent 化之后错误会规模化（一个 agent 给 100 万人排同一份错行程），规模化的错误必须有规模化的核验/审计对冲。**

### 1.2 需求侧：采用率 ≠ 委托率，信任缺口是结构性的

- 全球 79–80% 用过 AI 做规划，**只有 6% 敢把大部分规划与预订交给 AI**（Amadeus 2026-03，n≈1,000：
  [官方白皮书页](https://amadeus.com/en/resources/white-paper/agentic-ai-airlines)）；
- **68% 仍更愿在可信品牌下单、66% 不接受 AI 代为预订、仅 8% 规划时依赖 AI chatbot**（Expedia × YouGov 2026-03，
  n=5,700+，一手：[Nasdaq 新闻稿](https://www.nasdaq.com/press-release/expedia-group-reveals-ai-trust-gap-travelers-embrace-ai-planning-rely-trusted-brands)）；
- 中国更极端：**86%+ 试过 AI 咨询行程，但 67.5% 拿到推荐后会去 OTA 二次核验**（《2026 中国旅游 AI 营销白皮书》，
  n=2,971，二手转述；另 China Trading Desk Q3 2026（n=15,135）显示 33.2% 出境游客用 AI 规划，
  [一手公司页](https://www.chinatradingdesk.com/post/the-chinese-traveller-algorithm-part-2-who-makes-the-final-cut-by-subramania-bhatt)）。
  **「复核」本身就是刚需，而平台自己不做。**

### 1.3 机器侧的证据：AI 行程的错误是高频、可验证、且没人做成品牌

- 356 份真实 AI 行程的 telemetry：**43% 的行程日至少含一个可验证错误**（414 次提前到场、159 次超闭馆、
  127 次落在闭馆日、210 次重复地点、305 天绕路；厂商自述数据，量级参考：
  [r/AI_travel_tips](https://www.reddit.com/r/AI_travel_tips/comments/1wawlkv/travel_apps_websites_tools_megathread/p95ql0o/)）；
- 35.3% 用过 AI 规划的人遇到过错误信息（方向 18.1%、营业时间 14.3%、起降时间 10.4%），16.2% 因此亏过钱
  （Send My Bag 2026-10 调查：[链接](https://www.sendmybag.com/blog/send-my-bag-travel-trends-survey/)）；
- 竞品侧：MonkeyEatingMango 做了 46 条检查、Tripomatic 26.6 才加「每日强度评分 + 陡坡警告」，
  但它们都只是**单点提醒**——没有「评分 + 证据 + 修复 + 改后重验 + 行中重排」的闭环；
- **「检查」正在 6–12 个月内被商品化**：高德 2026 原生 15 维推演（营业时间/节奏/停车/拥挤 + 改进建议，
  [凤凰科技](https://tech.ifeng.com/c/8wnBVC4xuhK)）、Ask Maps 全球铺开并支持拍照纠正营业时间、
  Tripomatic/MonkeyEatingMango 加检查项。**只做「检查」会死；要做「可对账的判定与凭证」。**

### 1.4 我们的上一轮定位已经被正面对撞

- 高德 2026 把「体检 + 改进建议 + 行中重规划」做成数据源原生能力 → 我们 L2「规则体检」的稀缺性在中国被证伪；
- 内容起手被内容方收回：**2026-10-26 小红书全资入股圆周旅迹关联公司**
  （[东方财富](https://finance.eastmoney.com/a/202610263907804071.html)）；腾讯地图 V11 把内容→行程→协作→行中做进地图 App；
- **同命题竞品已出现**：PhocusWire 2026-10-18 报道 Tripician（AI 生成 + live Places 验真 + 纯函数可行性引擎 + 协作，
  [报道链接](https://www.phocuswire.com/interviews/startups/startup-stage-tripician-uses-ai-to-build-verified-collaborative-travel-itinerari)）。
  我们的判断被独立验证，但**窗口在关**（证据强度：中偏强；最大空白是零直接付费证据）。

### 1.5 数据与合规把「事实库」这条路堵死了

- Google Places/Routes 条款：**禁止与非 Google 地图同用**（Places §14.2 / Routes §19.2），仅允许缓存 lat/lng 30 天
  （§14.3/§19.3），ToS §3.2.3 禁止缓存内容 —— 见
  [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)；
- **高德现行协议（2025-12-03）§7.3/§3.5 禁止存储、缓存、下载数据**，§3.2.1 商业目的需事先购买技术服务许可
  （[协议原文](https://developer.amap.com/pages/terms/)）；
- 结论：**我们（以及任何单人团队）都不该建事实库**。正确的形态是——
  **引擎与凭据归我们，数据许可归客户/来源**；`POST /api/verify` 无状态、不落库，正好符合。

---

## 2. 新形态：三层结构

```
┌──────────────────────────────────────────────────────┐
│ 分发面   HTTP API · MCP（ChatGPT/Claude/agent）· JSON-LD │  ← 让任何 AI/OTA 接进来
├──────────────────────────────────────────────────────┤
│ 凭据层   可复算 ID · 规则版本 · 三态证据 · JSON 报告      │  ← 「证据」而不是「信任」
├──────────────────────────────────────────────────────┤
│ 引擎层   确定性规则（17 条）· 两轴判定 · Apache-2.0 标准  │  ← 唯一护城河：可被审计
└──────────────────────────────────────────────────────┘
          ↑ 展示面：/verify 体验台 · 分享页凭据 · 行程工作台
```

- **为什么引擎能当护城河**：规则公开、测试可跑、凭据可复算——护城河不是「藏起来」，而是
  **规则积累 + 与真实世界事实源的工程债 + 迁移成本**（别人抄规则容易，抄「三态治理 + 审计口径」很难）。
- **为什么凭据有人要**：平台不背责 → 供给方需要「可证明没错」；消费者 66% 不信 AI 代订 → 需要「可点开的证据」；
  中国 67.5% 回 OTA 复核 → 复核动作本身可以产品化。
- **为什么 API/MCP 是分发而不是收入**：ChatGPT 目录当前不允许卖订阅/数字商品（获客渠道）；
  真正的现金流在 B 端「引擎/白标/审计」与按次核验包（S3+ 验证）。

---

## 3. 本轮已落地（2026-10-28，S1 · Trip Check v0.1 → S1.5 · 确定性修复）

| 层       | 交付                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 标准     | [TRIP-CHECK-STANDARD.md](TRIP-CHECK-STANDARD.md) v0.1：文档格式、三态语义、17 条规则、两轴报告、凭据公式、接口、版本策略、合规边界；JSON Schema `GET /api/verify/schema`                                           |
| 引擎     | `lib/verify/`：`types` / `rules` / `engine`（纯函数、可复算）/ `repair`（确定性修复）/ `schema` / `validate` / `credential`（sha256 规范 JSON）/ `adapt`（内部 Plan→开放文档）/ `jsonld`（schema.org TouristTrip） |
| API      | `POST /api/verify`（document 或 shareId；CORS；限流；无状态不落库）；`POST /api/verify/repair`（修复 + 前后凭据链，**不写回**）；`GET /api/verify` 元信息；`GET /api/verify/schema`                                |
| MCP      | `POST /api/mcp`（JSON-RPC 2.0 stateless）+ `mcp/stdio.mjs` 本地桥；工具：`verify_itinerary` / `repair_itinerary` / `verify_shared_trip` / `get_trip_check_schema` / `list_rules` / `explain_rule`                  |
| 体验台   | `/verify`：粘贴 JSON / 载入三份示例 / 用分享链接体检；两轴报告 + 规则证据 + 凭据区块 + **确定性修复**（前后对比 + 凭据链 + 修不了的原因）                                                                          |
| 产品接入 | 分享页输出 schema.org JSON-LD；行程可一键在 `/verify?share=<id>` 打开开放凭证                                                                                                                                      |
| 测试     | 引擎/适配/凭据/JSON-LD/校验单测 + e2e 切片 + UI 组件测试（最终以 `npm run gate` 为准）                                                                                                                             |

> 诚实声明（必须出现在所有对外文案里）：MOCK 模式 / 未声明来源的文档**不会被说成「真实世界核验」**；
> 示例里的营业时间是示意数据，不构成真实营业时间承诺；凭据**不是数字签名**，只保证可复算。

### 3.1 S1.5 增量：从「判定」到「确定性修复 + 前后凭据链」

调研里最硬的空白是「43% 的 AI 行程日含可验证错误，但没人给修复闭环」。S1 的核验层判得对、
但不修；S1.5 把闭环补上：**确定性修复器**只做两类有数据依据、不改变语义的变换（顺延时间轴、
删除同一天重复点位），绝不编造地点/营业时间/路段，也不替用户做换点/删点/改日期的取舍；修不了的
问题逐条给原因。修复同时签发**前后两张凭据**（parent → child），任何一方可分别复算：
「改了什么、风险降了多少」从自说自话变成可对账的事实。这让 Trip Check 从「检测器」变成
「检测器 + 确定性自动纠错器」——竞品抄得动规则，抄不动「同一套引擎既判又修且可复算」的闭环。

### 3.2 S1.6 增量：核验层进入产品主流程（工作台第五镜头 + 持久化修复版本）

S1/S1.5 的核验层此前还是「产品外面的一套工具」：分享页一张凭据卡、`/verify` 一个体验台，
工作台里用户看不到两轴证据，也不能把修复结果搬回自己的行程。S1.6 把它接进主流程：

- **工作台第五镜头「体检」**（`/w/<id>?view=check`）：两轴结论 + 规则级证据 + 凭据 +
  确定性修复入口；分享页的凭据卡深链到这里。
- **`POST /api/plan/check`**：只读判定（同一 Plan → 开放文档 → 同一引擎），返回 `planRevision`
  做乐观并发；**`POST /api/plan/repair`**：先预览（before/after/applied/unrepairable/前后凭据），
  `confirm:true` 才写回并 `revision+1`，`expectedRevision` 不匹配返回 409。
- **只写机械变更**：`applied.spotIndex` 把顺延/去重套回 Plan（不丢 period/reason/rainBackup），
  写回后 `refreshTimeWarnings` 重算时间轴/营业时间预警，保证产品内旧徽章与新判定不打架。
- **采纳痕迹**：`plan.tripCheck` 记录 parent→child 凭据、修复次数与时间；分享页显示「已确定性修复」
  与凭据链（可对账），但不改变分享页只读语义。

这让「体检 → 证据 → 预览 → 确认写入 → 新版本凭据」成为一个产品内闭环，而不是演示台。

### 3.3 S1.7 增量：可分享的体检报告工件 + 基于营业窗口的建议

结论锁在产品里就不会传播。S1.7 把「证据」本身变成可转发的东西：

- **三件套**（同一模型 `lib/trip-check-report.ts`）：`/p/<id>/check` 公开报告页（只读、无状态）、
  `/p/<id>/check/poster` 竖版海报（与行程海报同一套纸面语言）、纯文本报告（微信/邮件可粘贴）。
  转发的是「这条行程被验过 + 证据 + 凭据」，不是又一份行程表——这正是调研里没人产品化的一格。
- **建议不越界**：`TC-F204`（营业时间对不上）现在会从文档自带事实算出 `suggestion`
  （当天营业窗口 + 原定停留放得进哪一段）；闭馆日/读不出窗口就不给建议。只建议、不修改。
- **诚实边界**：MOCK/未核验行程的页面与海报不得写成「已核验」；凭据可复算、不是签名；
  报告是时点结论。

---

## 4. 路线图（以「有没有人为证据付钱」为门槛）

| 阶段                               | 内容                                                                                                                                                                                                                  | 验收                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **S1（本轮，已完成）**             | Trip Check v0.1 + S1.5 确定性修复 + S1.6 产品内闭环 + S1.7 可分享报告工件：引擎/标准/API/OpenAPI/MCP/体验台/分享页凭据/工作台体检镜头/修复写入版本/公开报告页与海报                                                   | `npm run gate` 全绿；体检结论可在 `/p/<id>/check` 与海报中传播，MCP tools 可调（含 `repair_itinerary`），OpenAPI 契约可发现 |
| **S2（2 周，零外部依赖可做一半）** | ① 真实高德 key 验收（叙事前提，见 NEXT_STEPS）；② 凭据 PDF/竖版海报与分享页凭据卡；③ **3 个买方问价**：OTA 客服/退款、文旅局目的地页、商旅 TMC 合规；④ MCP 上架材料（ChatGPT Plugins 需公网 HTTPS + 域名验证 + 审核） | 至少 1 个买方明确「愿意为核验/凭证付费或试点」或明确否证；否则不投入 S3                                                     |
| **S3（1–2 月，有买方信号才做）**   | 凭据签名（HMAC + 密钥轮换，解决「签发者」语义）；客户规则配置（自家阈值）；白标报告页 + 审计日志；B 端数据授权架构（客户持数据许可）                                                                                  | 一份可对外报价的 B 端方案；一条真实客户链路                                                                                 |
| **S4（商业化试点）**               | 按次核验包 / B 端月费；C 端免费层保留；**避开订阅暗扣费**（App Store 规划类负面 29% 是扣费/付费墙）                                                                                                                   | 有收入或明确不做的结论                                                                                                      |

**明确不做（本轮及以后一段时间）**：

- ❌ 全球事实层（Google 条款锁死「非 Google 地图不可用」+ 30 天缓存限制；对单人 = 永久合规债）
- ❌ 事实库/POI 数据囤积（高德 §7.3；白标形态应是客户持许可）
- ❌ 通用 chat / 对话主入口（已被 ChatGPT/Claude/豆包吸收）
- ❌ 预订/库存/比价（无供给资质；会污染「中立核验」定位）
- ❌ 多人实时协作（App Store 负面仅 4%，Wanderlog/腾讯地图免费给；不是差异化）
- ❌ 内容 UGC 社区（小红书/腾讯已收编内容入口，单人做不动审核与运营）

---

## 5. 度量

**保留**：北极星「照着走完率」（`lib/metrics.ts`，已有）。
**新增（S1.5/S1.6 已具备计算条件）**：修复前后结构分差（`delta.score`）、机械修复采纳率
（`plan_repaired` 事件 / 有修复机会的行程）、`unrepairable` 占比（越大说明「只能人工」的部分越多）；
原始过程指标如下。
**原始过程指标（先埋点，后 Dashboard）**：

- 凭据被复算次数（`/api/verify` 同 `credential.id` 重复调用）；
- 外部文档体检量 / 成功报告率（区分 document vs shareId）；
- MCP 工具调用量（按 tool 名）；
- 改后重验率（产品内：改行程 → 再体检）；
- **反指标**：误报率（规则误报 / 用户反馈「其实没问题」）、MOCK 被误读率（UI 声明覆盖率）、API 滥用/限流命中率。

**本轮不做订阅制付费墙**（App Store 规划类 2026 年负面 29% 是扣费问题）；如果未来收费，
优先「按次核验包 / B 端服务」，且必须在首屏写清价格与取消方式。

---

## 6. 风险与前置条件

| 风险                                            | 级别                 | 对策                                                                      |
| ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------- |
| 真实高德 key 未验收，对外不能说「真实世界核验」 | 高（叙事前提）       | S2 第一件事；在此之前所有对外文案只承诺「可判定的结构与三态」             |
| 高德 §7.3 禁止存储；现有 Plan 持久化 POI 事实   | 高（商用前法务阻断） | 商用/收费前书面授权，或改为「只存引用 + 短 TTL」；核验 API 已无状态不落库 |
| 零直接付费证据（最大空白）                      | 高                   | S2 三个买方问价，达不到信号就不投入 S3                                    |
| Tripician 等竞品先占位，窗口 6–12 个月          | 中高                 | 速度 > 完整度：先把可复算凭据/API/MCP 做出来（本轮已做），再谈完备        |
| MOCK 演示被误读为真核验                         | 中                   | 全链强制 `source: mock` / `not_checked` + 三态文案 + UI 声明（已实现）    |
| 规则误报损伤信任                                | 中                   | 规则可解释、每条带证据；公开规则集版本；S2 收集误报样本迭代               |
| 单人带宽（B 端销售/法务不是代码）               | 中                   | S2/S3 只做「可验证切片」，买方验证优先于功能扩张                          |

---

## 7. 决策记录

| 决策                                    | 理由                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 从 To C「会体检」转向「可执行性核验层」 | 平台不背责 + 委托率 6–8% + 中国 67.5% 复核；卖证据给「已经拥有信任的一方」比向 C 端卖信任更可行 |
| 两轴报告（结构 vs 事实），不做一个总分  | 一个总分会把「没核验」洗成「没问题」；证据必须可拆开对账                                        |
| 凭据用确定性哈希，不做签名              | 没有密钥托管时做签名只会制造假信任；可复算才是当前能诚实提供的价值                              |
| 开放标准 + Apache-2.0                   | 与仓库许可一致；开放规则才能被审计/被引用；分发靠 API/MCP/JSON-LD，不靠闭源                     |
| 不做全球化事实层                        | Google/高德条款双重锁死；单人团队无法承担多源合规                                               |
| 本轮不接支付/订阅                       | 29% 规划类负面是扣费问题；先做证据价值，再谈收费                                                |

详见 [ADR-012](adr/012-trip-check-open-verification.md)。

---

## 8. 关键来源（2026-10-28 访问；完整清单见本地 `research/2026-10-global/`）

- Expedia×YouGov「AI Trust Gap」（n=5,700+）：https://www.nasdaq.com/press-release/expedia-group-reveals-ai-trust-gap-travelers-embrace-ai-planning-rely-trusted-brands
- Amadeus《Airlines in the agentic age》（n≈1,000）：https://amadeus.com/en/resources/white-paper/agentic-ai-airlines
- Sabre MCP（官方）：https://www.sabre.com/resources/newsroom/mcp-is-the-new-ndc-is-this-travels-shift-to-streaming-moment/
- Claude Connectors（官方）：https://claude.com/blog/connectors-for-everyday-life
- PhocusWire 报道 Tripician（2026-10-18）：https://www.phocuswire.com/interviews/startups/startup-stage-tripician-uses-ai-to-build-verified-collaborative-travel-itinerari
- 高德 2026「15 维推演」：https://tech.ifeng.com/c/8wnBVC4xuhK
- 小红书入股圆周旅迹（2026-10-26）：https://finance.eastmoney.com/a/202610263907804071.html
- China Trading Desk Q3 2026（n=15,135）：https://www.chinatradingdesk.com/post/the-chinese-traveller-algorithm-part-2-who-makes-the-final-cut-by-subramania-bhatt
- Send My Bag 2026-10 调查：https://www.sendmybag.com/blog/send-my-bag-travel-trends-survey/
- schema.org TouristTrip：https://schema.org/TouristTrip
- TravelPlanner 基准（GPT-4 成功率 0.6%）：https://arxiv.org/abs/2402.01622
- MCP TypeScript SDK：https://github.com/modelcontextprotocol/typescript-sdk
- 高德开放平台协议：https://developer.amap.com/pages/terms/ ；Google Maps Platform 条款：https://cloud.google.com/maps-platform/terms / https://cloud.google.com/maps-platform/terms/maps-service-terms
