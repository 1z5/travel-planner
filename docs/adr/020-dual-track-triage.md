# 020 计划/实际双轨 + 事件驱动陪伴：重构三类清单

- 状态：已接受（2026-11-16 评估结论，实现按「执行顺序」推进）
- 上游评估：代码库扫描结论为「混合路径」——保留确定性引擎，替换执行数据层，新建事件层

## 背景

产品方向从「一次性生成行程」转为「计划为辅、陪伴为主」：实际轨迹（打卡/位置/停留/照片）
成为一等数据，驱动局部重规划与地点讲解。

评估事实基线（2026-11-16 实测，均可复现）：

- 数据模型无双轨：`prisma/schema.prisma` 84 行 5 个 model，`Plan.plan` 为单 JSON blob；
  `ActualVisit` / `DeviationEvent` / `Checkin` / `actual_trajectory` 全仓零命中。
- 执行状态在客户端：`lib/trip/trip-execution.ts` 存 localStorage（键 `tp.execution.v1`），
  只有 `departedAt/arrivedAt` 两个时间戳，不参与行程演化，只喂埋点。
- 局部重规划求解器已存在：`lib/plan/replan.ts` 341 行纯函数（时间窗 + 真实 legs +
  营业时间 + 锚点墙 → kept/dropped/notes），输入是客户端时钟而非位置事件。
- 照片上传零基础：全仓 `formData|multipart|upload` 零命中。
- 定位只有一次性 `getCurrentPosition`（3 处），无 `watchPosition` 持续轨迹。

本 ADR 记录架构级清理的三类清单。判断标准：系统复杂度与长期维护成本下降，
不是 diff 最小。每条删除/替换都附影响面、迁移方案、回滚边界。

## 一、保留（不动或仅扩展）

| 模块                                                                                                             | 依据                                                                                                          | 扩展点                                                                   |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `lib/geo/amap.ts`（33K）                                                                                         | POI 验真/候选检索/路段/建议的确定性空间层                                                                     | `reverseGeocode` 用于「打卡位置 → 地点名」                               |
| `lib/plan/replan.ts`（341 行）                                                                                   | 事件驱动局部重规划的求解内核，已有单测                                                                        | 输入增加位置事件（`from` 可由打卡位置推导）                              |
| `lib/plan/grounding.ts`（516 行）                                                                                | 事实先行：生成前注入真实 POI 清单                                                                             | 复用于「附近 POI 召回」，作为动态推荐候选源                              |
| `lib/plan/candidates.ts` + `/api/plan/candidates`                                                                | 真实候选对比 + 确定性替换，不重抽 LLM                                                                         | 作为重规划建议的候选来源                                                 |
| `lib/plan/schedule.ts` / `poi-hours.ts` / `budget.ts` / `fix-actions.ts`                                         | 确定性排程/营业时间/预算/修复模板                                                                             | 无                                                                       |
| `lib/plan/validate.ts` + `lib/verify/{engine,rules,types,credential,repair,sha256,stamp,adapt,schema,jsonld}.ts` | 体检与开放核验引擎；`/api/plan/check`、`WorkspaceCheck`、`TodayView` 的 FactsVerdict 均依赖；确定性优先的体现 | 规则集可加「实际轨」维度（v2）                                           |
| `lib/plan/change-impact.ts` + `executability.ts`                                                                 | 改前/改后证据对比                                                                                             | 直接服务「用户确认/拒绝」状态机                                          |
| `lib/plan/fast-draft.ts`（264 行）                                                                               | 秒级初版用真实 POI 名单，诚实可用                                                                             | 无（其 legacy 前身 `draft-plan.ts` 删除，见 D1）                         |
| `lib/plan/ics.ts`                                                                                                | 日历导出（家人场景：行程进手机日历）                                                                          | 无                                                                       |
| `lib/auth/*`                                                                                                     | 短信 + 微信 + session                                                                                         | 打卡上云的账号维度前提（`trip-execution.ts` 注释预言的「登录体系补齐」） |
| `lib/server/*`                                                                                                   | http-body/http-origin/ratelimit/metrics/track 安全与度量基线                                                  | `metrics.ts` 事件枚举扩展                                                |
| `lib/store/*`                                                                                                    | 存储抽象（memory/postgres 双实现）                                                                            | 新增 ActualVisit/CheckinPhoto/DeviationEvent 三类 store                  |
| `Dockerfile` / `render.yaml` / `prisma/`                                                                         | 一条命令自托管 + 迁移管线                                                                                     | 新表走 migrate                                                           |
| 营销页（about/cities/privacy/terms/pricing）                                                                     | 开源门面；pricing 与「后续考虑商业化」一致                                                                    | 无                                                                       |
| `/p/[id]` 分享页                                                                                                 | 计划工件只读呈现 + Trip Check 凭据                                                                            | 无                                                                       |
| `/r/[id]` 旅程报告                                                                                               | —                                                                                                             | 扩展为「实际轨迹 + 照片」回忆报告（双轨的报告面）                        |
| `/new` + `home-client.tsx`                                                                                       | 计划创建入口                                                                                                  | 无                                                                       |

## 二、替换（重写或迁移）

### R1 执行状态：localStorage → 服务端 ActualVisit

- 现状：`lib/trip/trip-execution.ts`（188 行）localStorage。
- 目标：服务端 `ActualVisit`（store + `POST /api/trip/visit`）；`markArrived/markDeparted`
  API 形状保留，存储换成服务端。
- 影响面：`components/TodayExecutionCard.tsx`（唯一调用方）、
  `tests/lib/trip-execution.test.ts`、`tests/components/TodayExecutionCard.test.tsx`。
- 迁移：双写期（服务端为权威，本地保留为离线兜底）；服务端路径 e2e 通过后移除本地写。
- 回滚：本地写逻辑保留至服务端验证通过；回滚 = 恢复本地分支（单文件 revert）。

### R2 行程列表：localStorage 索引 → 账号维度

- 现状：`components/TripsHome.tsx` + `lib/plan/recent-trips.ts`（localStorage 索引）。
- 目标：按 `Plan.ownerKey`（已预留）的服务端列表；未登录用户继续本地索引。
- 影响面：`app/(app)/page.tsx`、上述两文件及其测试。
- 迁移：首次登录时本地索引 best-effort 归并（索引可重建，丢失可接受）。
- 回滚：本地索引代码即「未登录」路径，保留。

### R3 `components/TodayView.tsx`（1280 行单体）→ 执行面组件组

- 目标：NowCard（当前点）/ NextCard（下一站 + 出发建议）/ ReplanSuggestionCard
  （建议 + 采纳/拒绝）/ CheckinFlow（打卡 + 照片）/ DeviationBadge（超时提示）。
- 影响面：`app/(app)/t/[id]/page.tsx`、TodayView 测试、`scripts/visual-check.mjs` 选择器。
- 迁移：逐块搬运，每块单独过 `npm run gate`，旧文件最后删。
- 回滚：纯重构，git revert；无数据影响。

### R4 当前点解析：时间推断 → 位置事件驱动

- 现状：`spotNow()`（`lib/trip/trip-day.ts:95`）按计划时间推断「现在在哪一站」。
- 目标：新增 `spotNowByLocation`（`reverseGeocode` + 与 `spot.location` 距离判定）；
  时间推断保留为无定位时的降级路径。
- 影响面：TodayView、TodayExecutionCard、`trip-day` 测试。
- 迁移：新纯函数 + 单测先行；调用方「优先位置、回落时间」。
- 回滚：移除调用方位置分支即回旧行为。

### R5 重复纯工具收敛为 client-safe 单源

- 现状（注释自认的重复）：`parseTimeRange` 三份（`schedule.ts` / `replan.ts` /
  `replan/route.ts` 的 `parseClock`+`addDaysIso`）；`isRealDate` 三份（`trip-day.ts` /
  `validate.ts` / `verify/engine.ts`）；名称匹配两份（`replan.ts matchSpotName` /
  `validate.ts`）；haversine 两份（`geo/amap.ts` / `trip-day.ts distMeters`）。
- 目标：`lib/plan/time.ts`（时间/日期）、`lib/geo/spatial.ts`（距离）、
  `lib/plan/name-match.ts`（名称匹配）。
- 影响面：上述全部文件及对应测试（replan/schedule/trip-day/validate/verify 的测试
  钉了同组样本，`replan.ts:116-122` 注释明确要求两处一起改）。
- 迁移：先建单源 + 测试，再逐文件替换 import，每步过 gate。
- 回滚：每文件独立 revert。
- 理由：`deviation.time_overrun` 检测器是事件驱动的核心算术，不允许三份实现漂移。

### R6 行程管家重接地

- 现状：`lib/plan/copilot.ts` 只依据行程事实。
- 目标：事实载荷扩展为「计划 + 实际轨（ActualVisit/Deviation）」——陪伴对话的核心。
- 影响面：copilot、`/api/plan/chat`、`PlanCopilot.tsx`、copilot 测试。
- 迁移：载荷构造函数扩展；prompt 版本号 +1（`lib/prompts/` 约定）。
- 回滚：prompt 版本回退。

## 三、删除

### D1 `lib/plan/draft-plan.ts`（115 行，skeleton 骨架草稿）

- 依据：legacy 路径（`lib/types.ts:160-163` 自述「legacy，仅无 grounding 时」）；
  输出占位符 POI 名，直接违反「不猜、不假装」红线；`fast-draft.ts` 已覆盖其场景
  （真实 POI 名单）；无单测（`tests/lib/` 只有 `fast-draft.test.ts`）。
- 影响面：唯一调用方 `lib/jobs/jobs.ts`；`Plan.draftKind` 枚举。
- 迁移：jobs.ts 的 skeleton 分支改为「grounding 不可用 → 诚实等待态」，不产占位符；
  `draftKind` 删 `"skeleton"`，旧数据读取时按 `"fast"` 兼容（旧 skeleton 计划早已被
  精排版替换，标志实际已惰性）。
- 回滚：git revert；无持久数据依赖。

### D2 攻略提取：`lib/plan/trip-extract.ts` + `app/api/plan/extract/route.ts`

- 依据：产品线 B「内容起手」的竞品对标功能（解析小红书攻略链接），与双轨 + 事件驱动
  无关；解析第三方链接有 ToS 风险。
- 影响面：`app/home-client.tsx`（入口）、`lib/plan/pref-options.ts`（共享，保留）、
  `tests/lib/trip-extract.test.ts`、`tests/components/Home.test.tsx`。
- 注意：`lib/plan/trip-document-extract.ts` 是 Trip Check 的输入提取
  （`/api/verify/extract` 在用），**保留，勿误删**。
- 迁移：提取结果从不落库，无数据迁移。
- 回滚：git revert。

### D3 克隆：`plan-clone.ts` + `clone-count.ts` + `/api/plan/clone` + `CloneCTA.tsx` + PosterCover 克隆 CTA + DemoReadOnlyNote 克隆分支

- 依据：社交分发功能，MVP 规格明确 out-of-scope；其存在使 demo-seed 只读守卫
  复杂化（demo 计划「克隆不受影响」的特例）。
- 影响面：`app/(app)/p/[id]/page.tsx`、`TripWorkspace.tsx`、`DemoReadOnlyNote.tsx`、
  `tests/{lib/clone-count,components/CloneCTA,components/PosterCover,components/TripWorkspace}.test.tsx`。
- 迁移：分享页保留「用此条件新建」（行程条件带进 /new 表单，复用现有机制），
  去掉一键克隆写库；demo 计划恢复统一只读。已克隆出的 Plan 是独立记录，不受影响。
- 回滚：git revert。

### D4 愿望清单：`lib/plan/wishlist.ts` + `WishlistButton.tsx` + TripsHome 集成

- 依据：增长期「留存钩子」（其注释自述），纯 localStorage、无服务端价值，与陪伴主线无关。
- 影响面：`app/(app)/p/[id]/page.tsx`、`TripsHome.tsx`、
  `tests/{lib/wishlist,components/WishlistButton,components/TripsHome}.test.tsx`。
- 迁移：本地数据，删除即失效（无导出机制，接受丢失）。
- 回滚：git revert。

### D5 竖版海报：`lib/plan/poster-model.ts` + `app/(app)/p/[id]/poster/route.tsx`

- 依据：商业期传播物料；链接分享 + OG 预览图（`app/(app)/p/[id]/opengraph-image.tsx`，
  已验证不依赖 poster-model）已覆盖分享需求。
- 影响面：`app/(app)/p/[id]/page.tsx`（海报入口）、PosterCover 测试的海报部分。
- 迁移：海报是生成物，不落库，无数据迁移。
- 回滚：git revert。

## 四、冻结（不删除，停止演进）

**Trip Check 展示面**：`cli/` + `mcp/` + `scripts/build-verify-playground.mjs` +
`public/verify-playground*` + `.github/workflows/pages.yml` +
`app/(marketing)/verify/page.tsx` + `components/TripCheckPlayground.tsx`。

- 依据：与产品主线解耦（app/components/lib 对 `@/cli`、`@/mcp` 的 import 为零，已验证），
  但维护面约 4543 行 + CI + 文档 + 视觉回归页。
- 决策：**不删，冻结**——它正是「开源能力展示」的资产，且 ADR-019 的手机零冷启动
  入口依赖它。冻结 = 不加新功能、只修安全与依赖。若未来成为拖累，因解耦充分
  （cli/mcp 不 import app/），可一日内提取到兄弟仓库。
- 引擎库 `lib/verify/*` 不冻冻结范围（产品内体检在用，见保留清单）。

## 五、明确不做（防止过度工程）

1. **不把 Plan 单 JSON 迁成节点图**。依据：`legs`（from/to/durationSec）已构成邻接表，
   `replanSolve` 已在「文档 + legs 局部窗口」上工作；迁图是大迁移零收益，
   违背「维护成本下降」的成功标准。
2. 不删 `lib/verify` 引擎库（产品内体检与分享页凭据依赖）。
3. 不新建第二套 LLM 客户端或第二套 POI 客户端。
4. v1 不引入持续 GPS 轨迹（`watchPosition`）——打卡一次性定位 + 时间超时事件
   已支撑核心闭环；持续轨迹的后台保活/电量/隐私成本留给 v2 评估。

## 六、执行顺序

1. R5 工具收敛（偏离检测器的算术不能有三份实现）
2. R1 ActualVisit + 事件 API（双轨地基）
3. `replanSolve` 输入扩展（位置事件）+ 状态机（RECOMMEND → CONFIRM/REJECT）
4. R4 位置解析 + `deviation.time_overrun` 检测
5. R3 TodayView 拆分 + 打卡 UI
6. D1–D5 删除（每项独立提交、独立过 gate）
7. R2 账号行程列表、R6 copilot 重接地
8. 照片上传（v1 只存不分析）

## 后果

- 计划轨数据结构不变（无迁移风险）；实际轨从零新建，无历史数据迁移。
- 删除的 5 个模块共约 600 行产品代码 + 8 个测试文件，全部无持久数据依赖。
- 维护面净减：一处执行状态真相源（服务端）、一份时间算术实现、五个增长期功能。
- 新增成本：ActualVisit/CheckinPhoto/DeviationEvent 三表 + 照片存储选型（v1）。
