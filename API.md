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

建议轮询间隔 3 秒。任务结果保留 2 小时。

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
  "plan": { "...": "见下方 Plan Schema" }
}
```

**error** — 失败（配额已自动退还，remaining 为退还后的实时值）。分日路径的错误信息会带上进度
```json
{ "status": "error", "error": "第 4 天生成失败：生成连接被中断（已成功生成 3 天，配额已退还，可重试）", "remaining": 2 }
```

**404** — 任务不存在（服务重启/超过 2 小时/ID 错误）
```json
{ "error": "任务不存在或已过期，请重新生成" }
```

## 认证接口（M3：可选登录）

登录是增强不是门槛：未登录按 IP 计数（3 次/天），登录后按用户计数（10 次/天）。session 为服务端自签 HMAC cookie（`tp_session`，7 天有效，无数据库）。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/code` | 发送验证码。body `{phone}`；dev provider 固定码 `123456` |
| POST | `/api/auth/verify` | 校验。body `{phone, code}`；成功 200 并 `Set-Cookie` |
| POST | `/api/auth/logout` | 清除 cookie |
| GET | `/api/me` | 当前登录态：`{loggedIn, phone?, provider, remaining}` |

`AUTH_PROVIDER=sms` 时：验证码由腾讯云短信（TC3 直签，`lib/auth/sms.ts`）下发，服务端存储校验（5 分钟有效、一次性消费），需配 `SMS_SECRET_ID / SMS_SECRET_KEY / SMS_APP_ID / SMS_SIGN / SMS_TEMPLATE_ID`。模板内容形如「您的验证码是 {1}，5 分钟内有效」。

日历导出：`GET /api/plan/ics?id=<jobId>` 返回 `text/calendar`（每个 spot 一个 VEVENT，按 startDate 逐日偏移，本地浮动时间），任务过期返回 404。

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
    }>;
    transitMin: number;               // 服务端估算的当天通勤合计（分钟）
    transitKnown?: boolean;           // false = 通勤估算失败（高德波动），该天未做通勤/节奏判定
    dailyCostCny: number;             // 服务端汇总的当天人均花费
  }>;
  totalCostCny: number;
  tips: string[];
  warnings: string[];                 // 体检预警：绕路/节奏/预算（超预算与宽松都报）/区域分散/未验真/必游地漏排/住所未体现
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

## 契约测试

`fault_test` 套件（`npm test`，自包含：自动起桩 LLM + 隔离端口服务器）覆盖：正常链路、垃圾输出、空 content、上游 500、配额退还算术、参数边界、住所/必游地硬约束、LLM 输出结构核对（乱序归一化/天数不符）、分日流式（渐进交付的 daysReady 递增/中途失败不交付半成品）、预算体检对称性、LLM 连接中断重试——**151/151 通过**（2026-10）。

另有 50 条 Vitest 单测（`npm run test:unit`）覆盖高德三态语义、通勤两态、`mapLimit` 有界并发、`.ics` 的 RFC5545 细节。
