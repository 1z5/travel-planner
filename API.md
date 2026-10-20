# API 契约

Base URL：`/api`（与前端同源）

## POST /api/plan — 提交行程生成任务

异步模式：立即返回 `jobId`（202），生成在服务端后台进行，前端轮询 status 接口拿结果。

**生成耗时随天数分流**（这是 M6 引入的分日流式架构）：
- **1-4 天**：单次调用，约 3-5 分钟
- **5-7 天**：大纲 + 逐日生成，约 7 分钟（多天并发生成，实测比串行快约一半）。但**不必干等**——大纲秒级返回即写入骨架，之后每完成一批天就增量更新，前端轮询到部分 plan 即可开始渲染（渐进式交付）

### 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| city | string | ✅ | 2-20 字符 | 目的地城市，如 `成都` |
| startAt | string | ✅ | `YYYY-MM-DDTHH:mm` | 起始时间（本地，精确到分钟） |
| endAt | string | ✅ | `YYYY-MM-DDTHH:mm` | 结束时间；天数由起止时间推导（日历日含头含尾，**1-7 天；>7 天 400**） |
| budget | number | ✅ | 500-200000 | 人均总预算（元，不含往返大交通） |
| preferences | string[] | | 默认 `[]` | 偏好标签：美食/历史文化/自然风光/Citywalk/博物馆/购物/拍照打卡/小众冷门/亲子友好/夜生活 |
| hotel | string | | ≤40 字符 | **住所**（选填）：如 `全季酒店(春熙路店)` 或 `住春熙路附近`。全程以此为基地，第一天的酒店 spot 直接使用它 |
| mustVisit | string[] | | ≤5 个，每个 2-20 字符 | **期望必游地**（选填，硬约束）：必须全部出现在行程中；漏排会在 warnings 里显式告警 |
| pace | string | | `relaxed`/`balanced`/`packed`，默认 balanced | **行程节奏**：轻松（每天 1-3 主景点/净玩 ≤8h）/ 适中（2-4/≤10h）/ 紧凑（3-5/≤13h）。同时影响 prompt 密度与体检阈值 |
| transportMode | string | | `walking`/`bicycling`/`driving`，默认 driving | **交通方式**：决定每天相邻景点之间怎么走（`PlanDay.legs` 用真实路段按该方式计算，供「全程路线」与时间轴体检使用） |

```json
{ "city": "成都", "startAt": "2026-10-10T10:00", "endAt": "2026-10-12T18:00", "budget": 2500, "preferences": ["美食", "历史文化"] }
```

### 响应

**202** — 任务已创建
```json
{ "jobId": "job_muu1di2b1cp3x" }
```

**400** — 参数不合法（含畸形 JSON、字段缺失、越界）。error 为 zod 的 issue message
```json
{ "error": "目前支持 1-7 天行程：更长的行程请拆成多段分别规划" }
```

**429** — 今日免费次数用完（未登录默认 3 次/天/IP，登录用户 10 次/天）
```json
{ "error": "今日免费次数已用完（未登录每天 3 次）。登录后可提升到 10 次/天。" }
```

## GET /api/plan/status?id={jobId} — 轮询任务状态

建议轮询间隔 3 秒。**任务是执行记录**（结果只保留 2 小时，用于轮询拿到结果）；**行程本身是持久化资产**，done 时返回的 `shareId` 指向持久保存的分享 token，不受此 TTL 影响（生产 Postgres 模式行程不设过期；内存模式保留 30 天）。

任务心跳与自愈：服务端每次进度更新都会刷新 `updatedAt`；running 任务超过 `JOB_STALE_MS`（默认 20 分钟）没有心跳时（典型：进程被重启/杀掉），本接口会把它置为 error 并立刻返回，前端不必白轮询到 15 分钟。

### 响应

**running** — 生成中。分日流式路径（≥5 天）会带上已生成的 `plan` 与 `daysReady`，前端可据此渐进渲染，不必等 done
```json
{
  "status": "running",
  "elapsedMs": 45000,
  "plan": { "city": "京都", "summary": "…", "days": [ "…已生成的天…" ], "verification": "pending" },
  "daysReady": 2
}
```
> 注：`plan` 与 `daysReady` 仅在分日流式路径下存在且逐步增长；单次调用路径（≤4 天）只有 `status` 与 `elapsedMs`。

**done** — 成功
```json
{
  "status": "done",
  "remaining": 2,
  "shareId": "a1b2c3d4e5f6",
  "plan": { "...": "见下方 Plan Schema" }
}
```
> `shareId` 是**持久分享 token**（本次生成落库后的行程主键，生产环境不设过期）。分享页 `/p/<shareId>`、日历 `/api/plan/ics?id=<shareId>`、修改 `/api/plan/refine` 都用它。落库失败时字段为 `null`——此时仍能看到行程，只是没有持久链接（前端据此隐藏分享入口）。

**error** — 失败（配额已自动退还，remaining 为退还后的实时值）。分日路径的错误信息会带上进度
```json
{ "status": "error", "error": "第 4 天生成失败：生成连接被中断（已成功生成 3 天，配额已退还，可重试）", "remaining": 2 }
```
> 服务重启导致任务中断时：`{ "status": "error", "error": "生成已中断（服务重启或长时间无响应），请重新生成" }`。

**404** — 任务不存在（超过 2 小时/ID 错误）
```json
{ "error": "任务不存在或已过期，请重新生成" }
```

## POST /api/plan/refine — 改行程（换一个景点 / 一句话改一天）

对**已持久化**的行程做局部修改，不用整份重新生成、不占每日生成配额。同步接口（单次 LLM 小调用，通常 20-90 秒）。

### 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| shareId | string | ✅ | 6-40 位 URL-safe 字符 | 行程的持久分享 token（status done 返回） |
| action | `"swap"` \| `"day"` \| `"fix"` | ✅ | | `swap`=换一个景点；`day`=重排这一天；`fix`=按体检问题一键修复（服务端模板化指令，见下） |
| day | number | ✅ | 1-10 整数 | 目标天（1 基）。`fix` 的预算类只要求该天存在，服务端会按花费自动选天 |
| spotIndex | number | swap 必填 | 0-20 整数 | 当天第几个行程点（0 基） |
| instruction | string | | ≤100 字符 | `day` 模式的自然语言要求，如「想轻松点，多安排室内」。字符白名单（CJK/字母数字/常见标点，禁止引号/换行/花括号，防 prompt 注入）。省略则按当天主题重排。**`fix`/`swap` 不接受 instruction（400）** |
| fixKind | string | fix 必填 | `transit`/`pace`/`budget-over`/`budget-under`/`rain`/`hours` | **一键修复类别**。指令由服务端模板生成（用户输入不进 prompt，天然无注入面） |

```json
{ "shareId": "a1b2c3d4e5f6", "action": "day", "day": 2, "instruction": "这天想轻松点，多安排室内" }
{ "shareId": "a1b2c3d4e5f6", "action": "fix", "fixKind": "pace", "day": 1 }
```

**一键修复（fix）在修什么**：绕路→收拢动线；节奏超限→减少 1 个景点保证 21 点前结束；节奏偏松→加一个同区域景点；预算超/松→按花费自动选一天做压缩/提升；天气→室外换室内；闭馆/暂停开放→换成当天开放的同类型点。**修不了的问题不提供按钮**（未验真/境外无数据/系统波动/硬约束漏排/时间轴——后者走 `/api/plan/adjust` 确定性顺延）。

### 响应

**200** — 修改成功（已落库，分享链接同步到新版本）
```json
{ "plan": { "...": "完整新行程，见 Plan Schema" }, "revision": 3 }
```
`fix` 成功时额外返回 `appliedFix`（便于前端/日志追溯「AI 实际收到的模板指令」）：
```json
{ "plan": { "...": "…" }, "revision": 3, "appliedFix": { "fixKind": "pace", "instruction": "第1天减少1个景点，保证21点前结束，节奏按适中安排" } }
```
> 修改后服务端会**重新跑一遍体检**（POI 验真 + 通勤 + 营业时间 + 时间轴 + 预算/硬约束），`warnings`/`totalCostCny`/`dailyCostCny` 都是新的。硬约束不可被指令破坏：必游地/重点活动若会被删掉，服务端拒绝并返回 422。

| HTTP | 场景 |
|---|---|
| 400 | 参数非法 / day 或 spotIndex 越界 / 未知 fixKind / fix 带了 instruction 或 spotIndex |
| 404 | shareId 不存在或行程已被删除（旧 jobId 链接只读，同样 404 + 可行动文案） |
| 422 | 指令违反硬约束（如要求删掉必游地）、模型输出经重试仍不合格、或该问题当前已无需修复（如节奏已回到合理区间） |
| 429 | 修改太频繁（默认 `REFINE_HOURLY_LIMIT`=20 次/小时/IP，失败自动退还） |
| 502 | LLM 调用失败（error 已经是可行动文案） |

## POST /api/plan/adjust — 一键顺延时间轴（确定性重排，不调模型）

体检发现「时间接不上」（相邻两站之间留的时间不够走完那段路）时，用真实路段时长重排**当天**时间轴：保留每站停留时长与顺序、首站开始时间不变、后续按路段耗时顺接。**不调 LLM、不扣每日生成配额**，毫秒级返回。

### 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| shareId | string | ✅ | 6-40 位 URL-safe 字符 | 行程的持久分享 token |
| op | `"retime"` | ✅ | | 目前只有「顺延时间轴」 |
| day | number | ✅ | 1-10 整数 | 要重排的那天 |

```json
{ "shareId": "a1b2c3d4e5f6", "op": "retime", "day": 1 }
```

### 响应

**200** — 有改动（已落库，revision+1，时间轴/营业时间预警已刷新）
```json
{ "plan": { "...": "…" }, "revision": 2, "changed": true, "notes": [] }
```
**200** — 无需改动（幂等：连续调用第二次返回 changed=false，不落库、不涨 revision）
```json
{ "plan": { "...": "…" }, "revision": 2, "changed": false, "notes": ["时间轴已核对…"] }
```
`notes` 可能说明：顺延后超出 24:00 建议减少 1 个点 / 某活动是固定时间已按它排 / 某段缺真实路线按 0 分钟衔接。

| HTTP | 场景 |
|---|---|
| 400 | 参数非法 / 行程没有第 N 天 |
| 404 | shareId 不存在或已删除（旧 jobId 链接为只读，同样 404） |
| 422 | `这份行程缺少真实路段数据（未验真/旧版本），无法自动顺延时间轴` |
| 429 | 顺延太频繁（默认 `ADJUST_HOURLY_LIMIT`=60 次/小时/IP，失败自动退还；无改动不算失败） |

> 顺延只按真实路段重排，**不读营业时间**：首站开始时间保持不变、关门早于结束的情况可能无解（这类请用「一键修复」的营业时间类别或手动调整）。

## 行中模式页面 `/t/<token>`

出行当天的执行视角页面（与 `/p/<token>` 同源同一份 Plan，只是信息架构相反）：只显示今天、现在/下一站、今日时间轴与真实路段、天气，坏天气可一键「把今天改成室内路线」（内部调用 `refine` 的 `fixKind:"rain"`）。SSR 首屏只渲染与日期无关的骨架（「今天」必须按用户本地时区在客户端判定，避免服务端 UTC 猜错日期），因此 curl 看到的是骨架，hydrate 后才是今日内容。

- `/t/<shareId>` → 200；`/t/<无效 token>` → 200 + 友好失效页（非 500）

## POST /api/plan/chat — 行程管家（step-5 对话助手）

就着**某一份已持久化行程**回答用户问题，并在确实需要修改时给一个可执行建议（用户点了才执行）。同步接口：一次 step-5 调用，通常 10-40 秒（首次含推理）。

### 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| shareId | string | ✅ | 6-40 位 URL-safe | 行程持久 token |
| messages | array | ✅ | 1-12 条；最后一条必须是 user | `{ role: "user" \| "assistant", content: string }`，单条 1-500 字 |

```json
{ "shareId": "share_xxx", "messages": [{ "role": "user", "content": "第二天下雨怎么办" }] }
```

### 响应

**200**
```json
{
  "answer": "第 2 天有 3 个室外景点，其中 2 个有雨天备选……建议把当天改成室内路线。",
  "suggestion": { "kind": "fix", "fixKind": "rain", "day": 2, "label": "改室内" }
}
```
- `suggestion` 可能为空（信息不足/只是提问/与行程无关）。
- `kind:"fix"` 对应 `/api/plan/refine` 的 `action:"fix"`；`kind:"retime"` 对应 `/api/plan/adjust`。前端渲染成一个按钮，**点击后才执行**。
- 服务端严格校验建议：day 必须存在于该行程、fixKind 必须在枚举内、与用户意图不匹配则丢弃（回答照常返回）。

| HTTP | 场景 |
|---|---|
| 400 | 参数非法（空消息/最后一条不是用户/内容超长） |
| 404 | shareId 不存在或行程已删除 |
| 429 | 管家对话太频繁（默认 `COPILOT_HOURLY_LIMIT`=40 次/小时/IP，失败退款；不占生成/修改配额） |
| 502 | 模型不可用或连续两次输出不合法（error 已是可行动文案） |

> 回答准则（写在服务端 prompt 里）：只依据该行程事实（时间轴/真实路段/预算/预警/POI 评分与营业时间）、不编造 POI/价格/营业时间、拿不准就明说、只给一个最具体建议、拒绝与行程无关的请求。只读分享链接也能提问，但没有编辑权限时建议按钮禁用。

## 认证接口（M3：可选登录）

登录是增强不是门槛：未登录按 IP 计数（3 次/天），登录后按用户计数（10 次/天）。session 为服务端自签 HMAC cookie（`tp_session`，7 天有效，无数据库）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/code` | 发送验证码。body `{phone}`；dev provider 固定码 `123456` |
| POST | `/api/auth/verify` | 校验。body `{phone, code}`；成功 200 并 `Set-Cookie` |
| POST | `/api/auth/logout` | 清除 cookie |
| GET | `/api/me` | 当前登录态：`{loggedIn, phone?, provider, remaining}` |

`AUTH_PROVIDER=sms` 时：验证码由腾讯云短信（TC3 直签，`lib/auth/sms.ts`）下发，服务端存储校验（5 分钟有效、一次性消费），需配 `SMS_SECRET_ID / SMS_SECRET_KEY / SMS_APP_ID / SMS_SIGN / SMS_TEMPLATE_ID`。模板内容形如「您的验证码是 {1}，5 分钟内有效」。

分享与导出（持久化行程）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/p/<shareId>` | 持久分享页（只读 SSR）。追加 `?edit=1` 且本机生成过该行程（localStorage 有 token）时可继续修改 |
| GET | `/api/plan/ics?id=<shareId>` | 日历导出（`text/calendar`，每个 spot 一个 VEVENT，按 startDate 逐日偏移，本地浮动时间）。**也兼容旧的 `/api/plan/ics?id=<jobId>`** |
| GET | `/p/<jobId>` | 兼容早期分享链接（任务 TTL 内有效） |

`shareId` 不存在 → 分享页 200 + 「链接已失效」提示（不 500）；`.ics` → 404。

## GET /api/map — 每日真实路线地图（高德静态图代理）

把某天的站点坐标渲染成一张真实地图（底图来自高德静态地图；站点编号与路线连线由前端 SVG 覆盖层自绘——高德 `paths` 参数在当前 key 上不可用，详情见 CHANGELOG）。

`GET /api/map?loc=lng,lat;lng,lat;...&w=720&h=400&scale=2`

| 参数 | 约束 |
|---|---|
| `loc` | 1-10 个 `lng,lat`，`;` 分隔；坐标须在合理经纬度范围内 |
| `w` / `h` | 自动夹取到 320-1024 / 200-640 |
| `scale` | 1 或 2（2 = 高清，返回 2 倍像素） |

- **200** `image/png`，`Cache-Control: public, max-age=604800, immutable`（服务端另有 LRU 缓存，同一坐标组合不会重复打高德）
- **400** 参数非法 · **503** 未配置高德 key / `AMAP_MAP_DISABLED=1` · **502** 上游失败（前端回退到示意路线图，绝不显示破图）

微信登录（`AUTH_PROVIDER=wechat`）：`GET /api/auth/wechat/login?redirect=/` 跳转授权页（state+wx_state cookie 防 CSRF）→ 微信回调 `GET /api/auth/wechat/callback?code=&state=` 服务端换 openid → 签发同一套 session（标识为 `wx:<openid>`）。伪造 state → 400。

错误：手机号格式→400；验证码错误→401；配额用尽→429（文案区分登录/未登录并引导）。

## Plan Schema（done 时返回）

```typescript
{
  city: string;
  summary: string;                    // 一句话概览
  days: Array<{
    day: number;
    theme: string;                    // 当天主题
    spots: Array<{
      period: "morning" | "lunch" | "afternoon" | "dinner" | "evening";
      time: string;                   // "HH:MM-HH:MM"
      type: "sight" | "food" | "hotel" | "transport" | "shopping" | "activity";
      name: string;                   // POI 名称
      area: string;                   // 商圈/区域
      durationMin: number;
      costCny: number;                // 人均
      reason: string;
      rainBackup?: string;            // 雨天备选
      location?: string;              // "lng,lat"：高德验真命中时回填，用于真实地图/导航/行中距离
      poi?: {                         // 高德真实世界数据（验真命中时回填；缺失即不展示，不猜）
        rating?: number;              // 评分（4.8）
        avgCostCny?: number;          // 人均参考价（餐饮/景点，有则给）
        openTime?: string;            // 营业时间简版原文
        openTime2?: string;           // 营业时间完整原文（含闭馆日/季节/最晚进入）
        tel?: string;
        temporarilyClosed?: boolean;  // 高德显示暂停开放/已关闭
      };
    }>;
    transitMin: number;               // 服务端估算的当天通勤合计（分钟）
    transitKnown?: boolean;           // false = 通勤估算失败（高德波动），该天未做通勤/节奏判定
    legs?: Array<{                    // 相邻景点间的真实路段（按 transportMode 计算；旧行程可能没有）
      from: string; to: string;
      mode: "walking" | "bicycling" | "driving";
      distanceM: number; durationSec: number;
      steps: string[];                // 分步指令（已清洗，最多 3 条）
    }>;
    dailyCostCny: number;             // 服务端汇总的当天人均花费
  }>;
  totalCostCny: number;
  budgetCny?: number;                 // 用户输入的人均预算（预算使用率/分类构成用；旧数据可能缺失）
  tips: string[];
  warnings: string[];                 // 体检预警：绕路/节奏/预算（超预算与宽松都报）/区域分散/未验真/
                                     // 必游地漏排/住所未体现/营业时间与闭馆日/暂停开放/时间轴「时间接不上」
  verified: boolean;                  // true = 走高德真实验证；false = MOCK 模式
  verification?: "mock" | "ok" | "partial" | "pending";
                                     // 验真完成度。pending 仅出现在分日流式的 running 响应里
                                     // （生成中，尚未收尾）——此时不能误显示成「MOCK 模式」
}
```

## 错误目录（前端需要区分的）

| HTTP | 场景 | 用户文案建议 |
|---|---|---|
| 400 | 参数非法 | 按 error 原文展示 |
| 429 | 配额用尽 | 引导明日再来/登录 |
| 202 → error | LLM 连接中断（瞬时故障重试 1 次后仍失败） | 建议稍后重试；分日路径的错误信息已带「已成功生成 N 天」进度 |
| 202 → error | LLM 超时/断流 | 建议稍后重试，可减少天数 |
| 202 → error | LLM 输出不合法（重试 1 次后仍失败） | 建议重试 |
| 202 → error | 上游 API 故障 | 稍后重试 |
| 404 (status) | 任务过期/服务重启 | 引导重新提交 |
| 202 → error | 陈旧任务自愈（心跳超时，进程重启/被杀） | 「生成已中断，请重新生成」 |
| 404 (refine) | shareId 不存在/行程已删除 | 返回首页重新生成 |
| 422 (refine) | 指令会破坏硬约束，或模型输出不合格 | 换个说法/撤销该要求 |
| 429 (refine) | 改行程超过每小时上限 | 稍后再试 |
| 422 (refine fix) | 该问题当前已无需修复（如节奏已回到合理区间） | 展示原文，用户可改用「重排这一天」 |
| 429 (adjust) | 顺延时间轴超过每小时上限 | 稍后再试 |
| 429 (chat) | 行程管家对话超过每小时上限 | 稍后再试 |
| 502 (chat) | 管家模型不可用/输出两次不合法 | 展示 error，可用页面上的手动修复 |
| 422 (adjust) | 行程缺少真实路段数据（MOCK/旧版本） | 引导改用「重排这一天」 |
| 202 → error | 流式总时长兜底（上游挂住不发数据，超过 `LLM_STREAM_DEADLINE_MS`） | 「生成超过 N 分钟仍未完成，已中止」+ 建议重试/减少天数；配额已退还 |
| 503 (map) | 未配高德 key / 地图被禁用 | 前端自动回退示意图，无需文案 |

## 契约测试

`fault_test` 套件（`npm test`，自包含：自动起桩 LLM + 隔离端口服务器）覆盖：正常链路、垃圾输出、空 content、上游 500、配额退还算术、参数边界、住所/必游地硬约束、LLM 输出结构核对（乱序归一化/天数不符）、分日流式（渐进交付的 daysReady 递增/中途失败不交付半成品）、预算体检对称性、LLM 连接中断重试、**营业时间/闭馆日/暂停开放体检**、**时间轴「时间接不上」+ 一键顺延（changed/revision/幂等/错误码）**、**一键修复（appliedFix/错误码/防注入）**、**行中模式页面**、**流式总时长兜底（上游挂起）**——**290/290 通过**（2026-10）。

另有 Vitest 单测（`npm run test:unit`）覆盖高德三态语义、通勤两态、`mapLimit` 有界并发、`.ics` 的 RFC5545 细节、静态地图视野拟合与投影、行程持久化/修订、改行程 prompt 与硬约束、预算汇总、最近行程本地索引等（数量见 README 测试章节）。
