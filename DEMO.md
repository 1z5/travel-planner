# 面试演示上线（Render 免费版，约 10 分钟）

> 目标：**拿一个公网链接做面试演示**，不做正式生产运营。
> 正式上线（持久化 / 登录 / 监控 / 多实例）见 [DEPLOY.md](DEPLOY.md)，两套不要混。

这套方案 = **Render 免费 Web Service（Node runtime）** + **仓库内预生成行程 fixture**：

- 链接 24h 在线（免费实例 15 分钟无请求会休眠，冷启动 30-60 秒；面试前用预热脚本叫醒）；
- 预置的 2 条演示行程是**真实高德 + 真实模型生成**的产物，服务启动时自动灌入（`DEMO_SEED=1`），
  冷启动/重启后分享链接依然有效 —— 演示时 `/p/<shareId>` 秒开，不用等 3 分钟生成；
- 不依赖数据库、登录、域名备案；成本闸门在环境变量里收紧（见 §4）。

## 1. 一次性部署（10 分钟）

1. 打开 <https://render.com> → **Sign up with GitHub**（免费 plan 不需要信用卡）。
2. Dashboard → **New +** → **Blueprint** → 选仓库 `1z5/travel-planner` → **Apply**。
   Render 会读仓库根的 [`render.yaml`](render.yaml)，自动配好 build/start/健康检查/成本闸门。
3. 它会把 4 个 secret 标成待填（`sync: false`），按下面填：

   | 变量                   | 从哪里取                                              |
   | ---------------------- | ----------------------------------------------------- |
   | `LLM_API_KEY`          | 本地 `.env` 的同名值（不要发到聊天/截图里，自己复制） |
   | `LLM_BASE_URL`         | `https://api.stepfun.com/step_plan/v1`                |
   | `AMAP_WEB_SERVICE_KEY` | 本地 `.env` 的同名值                                  |
   | `SESSION_SECRET`       | 终端跑 `openssl rand -hex 32` 生成                    |

4. **Deploy** → 等 5-8 分钟（npm ci + prisma generate + next build）。
5. 部署成功后会得到形如 `https://travel-planner-demo-xxxx.onrender.com` 的地址。
   **不用配 `NEXT_PUBLIC_SITE_URL`**：缺省时 OG/绝对链接自动用 Render 注入的
   `RENDER_EXTERNAL_URL`（见 `app/layout.tsx`）。
6. 验证预热：

   ```bash
   node scripts/warm-demo.mjs https://travel-planner-demo-xxxx.onrender.com
   # 输出应全 ✅：健康检查、/ /new /about、两条预置行程 /p/<shareId>
   ```

> 免费实例第一次请求会冷启动（30-60s），`warm-demo` 会等它起来。
> 如果想让链接更「正式」（自定义域名/常驻），再走 DEPLOY.md 的服务器或云托管方案。

## 2. 面试前 2 分钟 checklist

- [ ] `node scripts/warm-demo.mjs <你的 URL>` 全绿（把休眠实例叫醒）
- [ ] 浏览器预先打开 3 个标签页：预置行程 `/p/<shareId>`、工作台 `/w/<shareId>`、新建 `/new`
- [ ] 手机打开一次 `/p/<shareId>`（确认移动端观感，面试官可能用手机看）
- [ ] 想清楚「现场生成」的讲法：真实模型 2-4 分钟，期间讲事实层与等待设计（见 §3）
- [ ] 兜底方案：网络/平台异常时，本地 `npm run dev`（真实 key 在 `.env` 里）直接打开 localhost:3000

预置行程的 shareId 在 `demo/fixtures/*.json` 里，`jq -r '.shareId' demo/fixtures/*.json` 可查。

## 3. 3 分钟演示脚本（按这个顺序讲，不慌）

1. **30s 定位**：不是「AI 帮你写行程」，而是「拿着真实世界排行程，出发前把风险摊开」。
2. **45s 预置分享页**（`/p`，秒开）：逐项指出
   - POI 名称/坐标来自高德实时检索（不是模型回忆）；
   - 营业时间与**闭馆日**在生成前就已核验，不会排到闭馆日；
   - 通勤是真实路段耗时，绕路/节奏/预算预警全部摊开、可一键修复；
   - 每个数字可溯源（预算透视、核验徽章）。
3. **45s 工作台**（`/w`）：「调整」镜头拖拽重排 + 一键顺延时间轴（确定性、不调模型）；
   行程管家问一句「第二天下午下雨怎么改室内」看结构化建议。
4. **30-60s 现场生成（可选）**：`/new` 填苏州 3 天 → 约 2 秒出现「秒级初版」（真实 POI 骨架）→
   讲「事实先行 + 流式逐天生长；生成期间可以离开页面，回来结果还在」。
5. **20s 收尾**：分享/OG 卡片、一键克隆（基于新日期重新核验闭馆/通勤）、旅程报告；
   北极星指标「照着走完率」为什么比「生成了多少份」诚实。

## 4. 成本与护栏（已配在 `render.yaml`）

| 变量                         | 值  | 作用                                              |
| ---------------------------- | --- | ------------------------------------------------- |
| `DAILY_FREE_LIMIT`           | 6   | 每个 IP 每天最多生成 6 次                         |
| `DAILY_GLOBAL_LIMIT`         | 40  | 全站每天最多 40 次生成（防链接被转发后刷爆）      |
| `DAILY_GLOBAL_LLM_LIMIT`     | 150 | 全站每天最多 150 次 LLM 调用（含改行程/行程管家） |
| `MAX_CONCURRENT_GENERATIONS` | 2   | 同时最多 2 个生成任务                             |
| `MAX_CONCURRENT_LLM`         | 2   | 同时最多 2 个 LLM 调用                            |
| `REFINE_HOURLY_LIMIT`        | 8   | 每 IP 每小时改行程上限                            |
| `COPILOT_HOURLY_LIMIT`       | 12  | 每 IP 每小时行程管家上限                          |
| `MAP_HOURLY_LIMIT`           | 300 | 每 IP 每小时静态地图请求（防烧穿高德静态图配额）  |
| `PLACES_HOURLY_LIMIT`        | 300 | 每 IP 每小时地址补全/必游地推荐                   |
| `GEOCODE_HOURLY_LIMIT`       | 60  | 每 IP 每小时逆地理编码                            |
| `WEATHER_HOURLY_LIMIT`       | 60  | 每 IP 每小时天气查询                              |

单条 3-4 天行程实测 1.5-3 万 tokens（见 DEPLOY.md 成本模型）。按上面的闸门，
**最坏情况一天也只会烧掉 40 次生成 + 150 次小调用**，成本有上限；
`GET /api/health` 的 `capacity` 字段能看到今日已用。

## 4.1 长期放简历（保活 / 监控 / 可靠性）

免费实例 15 分钟无请求会休眠，简历链接的第一位访客不该等 30-60s 冷启动。
仓库已带一个保活 workflow：`.github/workflows/keep-warm.yml`，**每 5 分钟** ping
一次 `/api/health`（Render 免费额度 750 实例小时/月，24/7 = 730h，够用；
失败了会给仓库 owner 发 GitHub 通知，等于免费 uptime 告警）。

**两个要记住的边界**：

1. **仓库连续 60 天没有活动，GitHub 会自动暂停定时 workflow**。长期挂简历的话，
   建议再加一层外部监控（二选一，都免费、都不需要信用卡）：
   - [UptimeRobot](https://uptimerobot.com)：HTTP(s) monitor，5 分钟间隔，可配邮件告警；
   - [cron-job.org](https://cron-job.org)：URL job，每 5 分钟 GET 一次 `/api/health`。
     任选一个把 `https://travel-planner-demo.onrender.com/api/health` 加进去即可。
2. **免费实例只有 512MB 内存**：3-4 天行程没问题；如果频繁被 5-7 天长行程打，
   可能 OOM。真要长期稳定，升级 Render **Starter（$7/月）**：不休眠、CPU 更强（0.5 核 vs
   免费 0.1 核；内存仍是 512MB，不会变大），还能绑自定义域名。这是唯一
   「花钱买确定性」的选项。

**看访问量（可选）**：`render.yaml` 里 `METRICS_TOKEN` 用了 Render 的
`generateValue: true` —— 在 Render Dashboard → 服务 → Environment 里能看到随机
token，然后打开：

```
https://travel-planner-demo.onrender.com/api/events/summary?token=<METRICS_TOKEN>
```

能看到漏斗、「照着走完率」、Top 城市、改动集中日（隐私口径：只收 shareId/城市/
第几天，不收手机号/IP）。简历面试时也可以顺手展示这个度量闭环。

**降低出错概率的三条日常**：

- 改动 fixture/代码后 push → Render 自动重新部署；部署期间链接可能 502 几十秒，
  `keep-warm` 会在下一轮自动恢复（不用手动点）。
- 每隔一阵（比如面试前一周）跑一次 `npm run demo:warm -- <URL>` 确认全绿。
- 如果哪天链接打开是 404 且 `/api/health` 正常：检查 fixture 是否被误删
  （`demo/fixtures/*.json`）与 `DEMO_SEED=1` 是否还在环境变量里。

## 5. 已知限制（面试被问到时主动说，反而是加分项）

- **免费实例会休眠**：15 分钟无请求 → 下次请求 30-60s 冷启动。面试前 `warm-demo` 叫醒。
- **存储是 memory**：现场生成的行程在实例休眠/重启后丢失；预置演示行程不受影响
  （fixture 静态存在仓库/构建产物里，启动时重新注入）。
- **没有登录**：生产守卫在 `NODE_ENV=production` 且未配 `AUTH_PROVIDER` 时自动关闭登录链路，
  所以演示站是「纯匿名 + 每 IP 6 次/天」。
- **免费实例 CPU 弱**：首屏与地图渲染比本地慢；生成速度取决于模型，不取决于实例。
- **单实例**：全局限流/并发闸门是进程内状态，只适用于单实例（正好匹配免费 plan）。

### 部署排障（万一卡住）

- **创建时报 region 不可用**：免费 plan 不一定每个区都有 → 把 `render.yaml` 的
  `region: singapore` 改成 `region: oregon`（默认区）再 Apply。
- **服务起不来 / 日志里端口未监听**：start 命令依赖 shell 语法。若日志显示
  `HOSTNAME=0.0.0.0: command not found` 之类，把 startCommand 改成
  `node .next/standalone/server.js`，并在环境变量里加 `HOSTNAME=0.0.0.0`。
- **/p 演示链接 404**：说明启动种子没跑——检查 `DEMO_SEED=1` 是否配到、部署日志里
  是否有 `[demo] 已注入 N 条演示行程`；fixture 不存在时重新跑 `npm run demo:gen` 并 push。
- **构建失败在 `next build`**：Render 免费构建内存有限，先看日志；本地 `npm run build`
  能过而 Render 失败通常是内存，换 Starter plan 或删掉 `.next` 重新触发即可。

## 6. 重新生成演示行程（可选）

日期按生成当天 +14 天自动算，所以演示行程会一直落在「未来」。

```bash
# 用仓库 .env 的真实 key 生成（会产生 LLM 费用；会起隔离 dev server，不碰你正在跑的）
node scripts/demo-gen.mjs
# 只重生成其中一条
DEMO_CASES=suzhou-3d node scripts/demo-gen.mjs

git add demo/fixtures && git commit -m "chore(demo): 重新生成演示行程" && git push
# Render 会自动重新部署（也可以手动 Deploy latest commit）
```

脚本自动重写 `demo/fixtures/index.ts`（静态 import，fixture 才会被打进 standalone 产物）。

## 7. 这套部署不适合什么

正式对外/长期在线/多实例/登录/付费/数据资产 → 不要用这套。
正式方案见 [DEPLOY.md](DEPLOY.md)：`DATA_STORE=postgres` + 登录厂商 + 监控告警 + 部署验收
（`preflight` / `smoke-deployed`）。审计里的 P0 清单见
`/Users/zephyr/dev/travel-planner-audit/2026-10-26-项目痛点审计.md`。
