# API 契约

Base URL：`/api`（与前端同源）

## POST /api/plan — 提交行程生成任务

异步模式：立即返回 `jobId`（202），生成在服务端后台进行（3-5 分钟），前端轮询 status 接口拿结果。

### 请求体

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| city | string | ✅ | 2-20 字符 | 目的地城市，如 `成都` |
| startAt | string | ✅ | `YYYY-MM-DDTHH:mm` | 起始时间（本地，精确到分钟） |
| endAt | string | ✅ | `YYYY-MM-DDTHH:mm` | 结束时间；天数由起止时间推导（日历日含头含尾，1-4 天；>4 天 400） |
| budget | number | ✅ | 500-200000 | 人均总预算（元，不含往返大交通） |
| preferences | string[] | | 默认 `[]` | 偏好标签：美食/历史文化/自然风光/Citywalk/博物馆/购物/拍照打卡/小众冷门/亲子友好/夜生活 |
| hotel | string | | ≤40 字符 | **住所**（选填）：如 `全季酒店(春熙路店)` 或 `住春熙路附近`。全程以此为基地，第一天的酒店 spot 直接使用它 |
| mustVisit | string[] | | ≤5 个，每个 2-20 字符 | **期望必游地**（选填，硬约束）：必须全部出现在行程中；漏排会在 warnings 里显式告警 |
| pace | string | | `relaxed`/`balanced`/`packed`，默认 balanced | **行程节奏**：轻松（每天 1-3 主景点/净玩 ≤8h）/ 适中（2-4/≤10h）/ 紧凑（3-5/≤13h）。同时影响 prompt 密度与体检阈值 |

```json
{ "city": "成都", "days": 3, "budget": 2500, "preferences": ["美食", "历史文化"] }
```

### 响应

**202** — 任务已创建
```json
{ "jobId": "job_muu1di2b1cp3x" }
```

**400** — 参数不合法（含畸形 JSON、字段缺失、越界）
```json
{ "error": "参数不完整：需要城市、3-5 天、预算（元）" }
```

**429** — 今日免费次数用完（默认 3 次/天/IP）
```json
{ "error": "今日免费次数已用完（每天 3 次）。明天再来，或微信号获取更多次数。" }
```

## GET /api/plan/status?id={jobId} — 轮询任务状态

建议轮询间隔 3 秒。任务结果保留 2 小时。

### 响应

**running** — 生成中
```json
{ "status": "running", "elapsedMs": 45000 }
```

**done** — 成功
```json
{
  "status": "done",
  "remaining": 2,
  "plan": { "...": "见下方 Plan Schema" }
}
```

**error** — 失败（配额已自动退还，remaining 为退还后的实时值）
```json
{ "status": "error", "error": "生成超时（7 分钟未返回），请稍后重试或减少天数", "remaining": 2 }
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
    transitMin: number;               // 服务端估算的当天通勤合计
    dailyCostCny: number;             // 服务端汇总的当天人均花费
  }>;
  totalCostCny: number;
  tips: string[];
  warnings: string[];                 // 体检预警（绕路/节奏/预算/未验真）
  verified: boolean;                  // true = 走高德真实验真；false = MOCK 模式
}
```

## 错误目录（前端需要区分的）

| HTTP | 场景 | 用户文案建议 |
|---|---|---|
| 400 | 参数非法 | 按 error 原文展示 |
| 429 | 配额用尽 | 引导明日再来/登录/付费 |
| 202 → error | LLM 超时（>7 分钟） | 建议稍后重试 |
| 202 → error | LLM 输出不合法（重试 1 次后仍失败） | 建议重试 |
| 202 → error | 上游 API 故障 | 稍后重试 |
| 404 (status) | 任务过期/服务重启 | 引导重新提交 |

## 契约测试

`fault_test` 套件覆盖：正常链路、垃圾输出、空 content、上游 500、配额退还算术、参数边界——16/16 通过（2026-10）。
