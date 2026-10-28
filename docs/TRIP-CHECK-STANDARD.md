# Trip Check · 行程可执行性核验开放标准 v0.1

> **一句话**：任何 AI 生成的行程，都可以用同一套确定性规则先过一遍体检，拿到一份**可复算、可对账**的结论与凭据。
>
> 状态：v0.1（2026-10-28）· 参考实现 Apache-2.0 · 规则集版本 `2026-10-28.1` · 引擎版本 `0.1.0`
> 实现：`lib/verify/`（纯函数引擎）+ `POST /api/verify` + `POST /api/mcp` + `/verify` 体验台

---

## 1. 为什么要有这个标准

2026 年的旅行 AI 市场有一个结构性矛盾（证据见 [PRODUCT-REVOLUTION-2026-10.md](PRODUCT-REVOLUTION-2026-10.md)）：

- **规划侧采用率已经很高**（全球 79–80% 用过 AI 规划，中国 86%+）；
- **委托率极低**（仅 6–8% 敢把大部分规划交给 AI），且 **68% 的人仍更信任品牌、66% 不接受 AI 代订**；
- 平台明确**不背责任**（OpenAI 关停站内结账、Google 让商家做 merchant of record、Claude 预订前先问用户）；
- 结果就是：AI 生成的行程**会规模化地错**，而错误没有规模化的核验来对冲。

现有产品的「检查」都是**单点、不可对账**的：给一条提醒、一个分数、一句「建议调整」。没有人给出
「**依据是什么、规则版本是什么、哪些事实查过/没查过、同一份输入别人能不能复算出同样结论**」。

Trip Check 要解决的就是这个：把「行程能不能照着走」变成一个**可公开复算的判定**，而不是一句营销话术。

## 2. 两条轴：结构自洽性 vs 事实核验

这是本标准和「一个总分」最重要的区别。一份行程可能**结构完美但事实全没核**，也可能**结构有硬伤但事实都真**。
把两者混成一个数字，等于用确定性掩盖不确定性。所以报告强制分两轴：

| 轴                            | 回答什么                                                     | 依赖什么             | 输出                                                    |
| ----------------------------- | ------------------------------------------------------------ | -------------------- | ------------------------------------------------------- |
| **结构自洽性**（consistency） | 按文档给出的时刻/时长/花费，这个行程**自相矛盾吗**           | 只需要文档本身       | 0–100 分 + A/B/C/D + 规则级问题                         |
| **事实核验**（facts）         | 地点是否真实、是否开门、路程是否可行，**谁核的、核到哪一步** | 文档声明的来源与三态 | 覆盖率 + verified / partial / unverified / inconclusive |

**红线**：结构轴永远不因「事实未核验」而扣分；事实轴永远不折成一个分数冒充「可信度」。
页面上两轴并列展示（`/verify`、分享页凭据），任何一方缺失都必须显式说明。

## 3. 文档格式（JSON）

规范版本：`"specVersion": "trip-check/0.1"`。完整机器契约见 `GET /api/verify/schema`（JSON Schema 2020-12）；
服务端限额：≤30 天、单日 ≤40 点、总点位 ≤200、名称 ≤120 字、预算 ≤1000 万元。

```jsonc
{
  "specVersion": "trip-check/0.1",
  "id": "sample_verified", // 可选：外部标识
  "city": "苏州", // 可选
  "budgetCny": 900, // 可选：人均总预算
  "provenance": {
    // 可选：文档级事实来源（点位/路段未声明时继承）
    "poi": { "source": "amap", "checkedAt": "2026-10-27T10:00:00Z" },
    "routes": { "source": "amap", "checkedAt": "2026-10-27T10:00:00Z" },
    "hours": { "source": "amap", "checkedAt": "2026-10-27T10:00:00Z" },
  },
  "days": [
    {
      "day": 1,
      "date": "2026-11-03", // 可选：没有日期则跳过营业时间判定（不猜周几）
      "spots": [
        {
          "name": "拙政园",
          "time": "09:00-11:00", // 必填：同日时段 "HH:MM-HH:MM"
          "type": "sight", // 可选：sight/food/hotel/transport/shopping/activity
          "durationMin": 120, // 可选：缺省则跳过节奏判定（不按 0 计）
          "costCny": 80, // 可选：缺省则跳过预算判定
          "area": "姑苏区",
          "location": "120.629,31.324", // 可选："经度,纬度"
          "hours": {
            // 可选：营业时间原文（与高德 open_time/opentime2 同构）
            "openTime": "周一至周日 07:30-17:30",
            "openTime2": "…含闭馆规则/季节/最晚进入的原文…",
            "temporarilyClosed": false,
          },
          "verification": {
            // 可选但决定事实轴：这条事实查没查、结果是什么
            "source": "amap",
            "existence": "hit", // hit | miss | error | not_checked
            "hours": "hit",
            "checkedAt": "2026-10-27T10:00:00Z",
          },
        },
      ],
      "legs": [
        // 可选：相邻点位路段；没有就诚实说「无法判断通勤」
        {
          "from": "拙政园",
          "to": "平江路",
          "mode": "walking",
          "durationMin": 20,
          "distanceM": 1300,
          "source": "amap",
          "state": "hit",
        },
      ],
    },
  ],
}
```

### 3.1 三态的语义（不可混用）

| 值            | 含义                              | 会怎样影响结论                                                                 |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------ |
| `hit`         | 从来源查到了这条事实              | 可能通过；`hours: hit` 会做营业时间判定                                        |
| `miss`        | 查询成功，但来源没有这条事实/地点 | 地点 `miss` → **blocking**（查不到的地点不能排）；营业时间 `miss` 只计入覆盖率 |
| `error`       | 查询失败（上游波动/限流/超时）    | **不判 blocking**，只报「不知道」（TC-F205），facts 最多 partial               |
| `not_checked` | 文档没声明查过                    | 计入「未核验」，永远不会被当成「没问题」                                       |

> `miss` 与 `error` 必须分开：把上游故障说成「地点不存在」是诬陷，把没查说成「没问题」是欺骗。

## 4. 规则表（规则集 `2026-10-28.1`）

规则 ID/文案/扣分是公开口径（`lib/verify/rules.ts` 是唯一权威）。严重度：`blocking`=走不通；`warning`=需微调；`info`=信息不足。

| 规则                       | 严重度   | 扣分        | 判定                                                                     |
| -------------------------- | -------- | ----------- | ------------------------------------------------------------------------ |
| `TC-C101` 时间格式无法解析 | warning  | 3           | `time` 不是合法同日时段（或跨零点/零长）→ 该天时间轴不可判               |
| `TC-C102` 两段时间重叠     | blocking | 45          | 相邻点位时间段重叠（负 gap）——物理上不可能                               |
| `TC-C103` 时间接不上       | blocking | 45          | 相邻点有真实 `leg.durationMin`，但 `gap < need`                          |
| `TC-C104` 缺少真实路段数据 | info     | 0           | 相邻点缺路段耗时 → 通勤可行性**不可判定**（不是通过）                    |
| `TC-C105` 关键字段缺失     | info     | 0           | 缺点位停留时长/花费 → 节奏/预算对应部分跳过（不用 0 补齐）               |
| `TC-C106` 当天通勤偏长     | warning  | 8           | 当天真实路段耗时合计 > 120 分钟                                          |
| `TC-C107` 节奏偏满         | warning  | 6           | 当天「停留 + 真实通勤」超过所选节奏上限（轻松 8h / 适中 10h / 紧凑 13h） |
| `TC-C108` 超出预算         | warning  | 3           | 全行程花费合计 > 预算 × 1.05                                             |
| `TC-C109` 同一天重复点位   | warning  | 5           | 同名点位在同一天出现多次                                                 |
| `TC-C110` 空白天           | warning  | 5           | 某天没有任何点位                                                         |
| `TC-C111` 同一天点位分散   | warning  | 5           | 当天景点跨 ≥4 个区域，且缺路段数据证明通勤可行                           |
| `TC-F201` 地点未核验       | info     | 0           | 有 `poiNotChecked` 个点位未声明存在性（聚合一条）                        |
| `TC-F202` 地点未命中       | blocking | 0（事实轴） | `existence: miss`                                                        |
| `TC-F203` 营业时间未核验   | info     | 0           | 未查/来源没有/原文无法解析（聚合一条）                                   |
| `TC-F204` 营业时间对不上   | blocking | 0（事实轴） | 有日期 + 营业时间原文，按 `checkOpenHours` 判定闭馆/不在营业时段         |
| `TC-F205` 核验源故障       | info     | 0           | 存在 `error` 状态（聚合一条），不当作地点不存在                          |

### 4.1 评分与等级

```
score = max(0, 100 - Σ(rule.penalty × min(该规则出现次数, 3)))
grade: score ≥ 90 → A；≥ 75 → B；≥ 60 → C；否则 D
```

- 同一条规则最多累计 3 次扣分（重复问题不该把分数扣穿，也不能当没看见）；
- 阻断级规则单条 45 分，**一次就跌破 60（D）**——分数与「能不能走」的语义必须一致；
- 事实规则不扣结构分（两轴分离，见 §2）。

### 4.2 事实轴状态

| state          | 条件                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `verified`     | 所有点位 existence 都是 hit/miss 且无 error；所有相邻路段有真实耗时；所有点位 hours 都「查过或来源没有」（无 not_checked/error） |
| `partial`      | 至少有一部分事实查过，但不满足上述全部条件                                                                                       |
| `unverified`   | 没有任何可用的事实核验（全部 not_checked，且无路段数据）                                                                         |
| `inconclusive` | 没有可核验点位（空文档/只有 transport 移动描述）                                                                                 |

## 5. 报告格式

`POST /api/verify` 返回的 `TripCheckReport`（字段见 `lib/verify/types.ts`）：

```jsonc
{
  "specVersion": "trip-check/0.1",
  "engine": { "name": "trip-check", "version": "0.1.0", "rulesetVersion": "2026-10-28.1" },
  "document": { "id": "…", "city": "苏州", "days": 2, "spots": 5, "budgetCny": 900 },
  "verdict": {
    "consistency": { "score": 100, "grade": "A", "gradeLabel": "可执行", "summary": "…" },
    "facts": {
      "state": "verified",
      "summary": "…",
      "coverage": {
        "poiTotal": 5,
        "poiChecked": 5,
        "poiHit": 5,
        "poiMiss": 0,
        "poiError": 0,
        "poiNotChecked": 0,
        "hoursChecked": 5,
        "routesTotal": 3,
        "routesChecked": 3,
      },
      "sources": { "amap": 5 },
    },
    "overall": "ok", // ok | warnings | blocking | unverified
    "summary": "…",
  },
  "issues": [
    {
      "ruleId": "TC-C104",
      "category": "consistency",
      "severity": "info",
      "title": "缺少真实路段数据",
      "detail": "…",
      "evidence": { "day": 1, "count": 1 },
      "fixHint": "…",
    },
  ],
  "stats": { "blocking": 0, "warnings": 0, "infos": 1, "total": 1 },
  "ruleset": { "version": "2026-10-28.1", "ruleIds": ["TC-C101", "…"] },
  "checkedAt": "2026-10-28T10:00:00.000Z",
  "credential": {
    "id": "tc_…",
    "algorithm": "sha256",
    "inputHash": "…",
    "specVersion": "…",
    "engineVersion": "0.1.0",
    "rulesetVersion": "2026-10-28.1",
    "issuedAt": "2026-10-28T10:00:00.000Z",
    "basis": "…",
  },
}
```

## 6. 凭据：可复算，而不是「数字签名」

凭据 ID 的计算口径（任何语言都能独立复算）：

```
inputHash = sha256(canonicalJson({ document, options }))
id        = "tc_" + sha256(`${specVersion}|${engineVersion}|${rulesetVersion}|${inputHash}`)[0:32]
```

- `canonicalJson`：对象键排序、省略 `undefined`、数组保序、非有限数字按 JSON 语义变 `null`；
- **同一份文档 + 同一口径 + 同一引擎/规则版本 → 同一个 ID**，与签发时间无关（`issuedAt` 只展示）；
- **它证明什么**：这份报告的结论可以被任何一方重跑核对（输入 → 结论的映射是确定且版本化的）；
- **它不证明什么**：不证明判定一定正确（规则是公开的，可以质疑/改进）、不证明事实源本身权威
  （事实质量取决于 `provenance` 声明）、**不是数字签名**（本版本没有密钥托管，不声称不可伪造）。
  下一步（S3）才会引入 HMAC/签名与密钥轮换，届时也必须先解决「签名只证明签发者，不证明结论正确」的叙事。

## 7. 接口

### 7.1 HTTP

| 方法/路径                | 说明                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/verify`       | 体检。body：`{ document }` **或** `{ shareId }`（二选一），可选 `{ options: { pace } }`                                                 |
| `GET /api/verify`        | 服务元信息（版本/规则/文档链接）                                                                                                        |
| `GET /api/verify/schema` | 文档 JSON Schema（公开契约）                                                                                                            |
| `POST /api/mcp`          | MCP（JSON-RPC 2.0、stateless）端点：`verify_itinerary` / `verify_shared_trip` / `get_trip_check_schema` / `list_rules` / `explain_rule` |

错误码：`400 invalid_request`（含 `errors:[{path,message}]`）、`400 invalid_json`、`404 not_found`（shareId 不存在）、
`413 payload_too_large`（body > 256 KiB）、`429 rate_limited`（默认 `VERIFY_HOURLY_LIMIT=120`/IP/小时）。

公开 API 带 CORS（`Access-Control-Allow-Origin: *`），可在浏览器/第三方站点直接调用；服务端不落库输入文档。

### 7.2 本地 stdio MCP

```bash
npm run dev          # 另开一个终端
node mcp/stdio.mjs   # 把换行分隔的 JSON-RPC 从 stdin 转发到 POST /api/mcp
```

## 8. 版本与兼容

- **specVersion**（文档格式）：不兼容变更升 minor（0.1 → 0.2）；旧文档在旧版本报告里继续可判。
- **engineVersion**：判定实现变化（bug 修复、边界处理）时递增。
- **rulesetVersion**：规则增删/阈值/扣分变化时递增。**任何一方对账时必须同时比对 rulesetVersion**。
- 报告 `ruleset.ruleIds` 给出该次判定生效的完整规则清单；规则元信息可用 `list_rules` 取。

## 9. 局限与明确不做

- 不判断**价格合理性 / 排队时长 / 临时限流 / 天气突变**（这些需要实时供给，不在 v0.1 规则内）；
- 不核验事实本身：地点/营业时间/路段的真实性取决于文档声明的来源（`provenance`）；本引擎只判定「按给定事实，行程是否自洽可行」；
- 不自动改行程：`fixHint` 只给方向；修改属于产品侧（本仓的换一个/一句话改/一键修复/重排）；
- 不做预订/库存/支付；不做通用聊天；
- MOCK/未核验数据必须显式标注 `source: "mock"` 或 `not_checked`，**不得以 MOCK 数据声称「真实世界核验」**。

## 10. 合规边界（重要）

- **高德开放平台协议 §7.3 / §3.5 禁止存储、缓存、下载高德数据**。因此本标准和参考实现：
  - 不建设「事实库」；`POST /api/verify` 是**无状态判定**，不落库输入文档；
  - 自家行程持久化 POI 事实是已知合规缺口（商用前需书面授权或改为「只存引用」）；
  - 对 B 端客户的正确形态是「客户持有数据许可，我们只提供引擎/凭证」，而不是我们替客户囤数据。
- 对外开放的是**判定规则与凭据格式**，不是任何地图/POI 数据授权；参考实现 Apache-2.0，数据仍受各自服务条款约束。

## 11. 参考实现与规则演进

- 代码：`lib/verify/`（types / rules / engine / schema / validate / credential / adapt / jsonld / samples）
- 测试：`tests/lib/verify/`（规则边界、两轴、三态、可复现、适配、schema 同步）
- 客户端接入示例：`/verify` 体验台（粘贴 JSON 或分享链接）；服务端接入示例：`app/api/verify/route.ts`

## 12. 变更记录

- 2026-10-28 v0.1：首版。17 条规则、两轴报告、可复算凭据、HTTP API、MCP 工具、JSON-LD 导出、公开体验台。
