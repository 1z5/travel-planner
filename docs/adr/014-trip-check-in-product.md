# ADR-014: Trip Check 进入产品主流程——工作台体检镜头与持久化修复版本

## 状态

已接受（2026-10-28，S1.6 全栈集成）

## 背景

ADR-012/013 把核验层做成了开放标准、API/MCP 与确定性修复，但它是**产品外的独立面**：

- 分享页只有一张凭据卡；工作台里用户看不到两轴结论、证据与修复入口；
- 产品内的「体检」还是旧的 `ExecutabilityBadge`（warnings 聚合），与 Trip Check 的
  规则级证据是两套语言；
- 修复只能通过 `/verify` 拿一份新 JSON，用户要自己搬回产品——这不是「闭环」。

用户要求「前后端全方位革新」，核验层必须**进入产品主流程**，否则它永远只是演示面。

## 决策

1. **工作台第五镜头「体检」**（`/w/<id>?view=check`）：同一份 Plan 的两轴报告、规则级证据、
   凭据与修复入口都在产品内；分享页的凭据卡可深链到这里。
2. **两个后端端点，语义分离**：
   - `POST /api/plan/check`：**只读**判定（planToDocument → engine → credential），
     返回 `planRevision` 供乐观并发；按 IP 限流，不占生成配额。
   - `POST /api/plan/repair`：**先预览后写入**。`confirm !== true` 只返回 before/after、
     applied、unrepairable 与前后凭据（`persisted:false`）；`confirm:true` 才把机械变更
     套回 Plan 并 `replacePlan`（revision+1）。`expectedRevision` 不匹配 → 409，避免覆盖
     用户在别处做的修改。
3. **写入的只有机械变更**：applied 里的 `spotIndex`（原始下标）用于把顺延/去重套回 Plan；
   Plan 的 period/reason/rainBackup 等文档外字段不丢。写入后调用 `refreshTimeWarnings`
   重算「时间轴 + 营业时间」预警——否则产品内旧徽章会和新判定自相矛盾（这是本轮最容易
   踩的坑：两套判定语言必须同步）。
4. **凭据链写进 Plan**：`plan.tripCheck = { credentialId, parentCredentialId, checkedAt,
repairedAt, repairCount, applied }`。为什么放 Plan JSON 而不是另建表：核验结论可重算，
   但「用户确实采纳过修复」是事件事实，重算不出来；Plan 已是带 revision 的 JSON 聚合，
   不引入迁移。只记录机械修复事实，不固化「体检通过」这类主观结论。
5. **分享页展示修复链**：`plan.tripCheck` 存在时显示「已确定性修复」与 parent → child
   凭据链，并可深链到工作台体检镜头。
6. **埋点**：`plan_repaired`（分享 token + 城市 + revision），用于观察「修复采纳率」；
   隐私口径不变（不存手机号/IP/行程内容）。

## 后果

- **产品内闭环**：体检 → 预览 → 确认写入 → 新版本 + 凭据链，全部在工作台完成；
  分享页的「证据」与工作台的「操作」指向同一份判定。
- **两套判定语言的对齐成本**：Trip Check（严格、规则级）与旧 warnings/ExecutabilityBadge
  仍并存；写回时用 `refreshTimeWarnings` 对齐时间/营业两类，其余（绕路/节奏/预算/未验真）
  与时间无关，保持原样。长期方向是让旧徽章改读 Trip Check 报告（S3 候选，不在本轮）。
- **并发与权限**：沿用「分享 token 即凭据」的既有模型（refine/restore 同口径）；
  `expectedRevision` 提供乐观并发保护，但不做账号级 owner 校验（未登录产品前提）。
- **不写回分享页只读场景**：分享页永远只读；修复必须回工作台显式确认。
- **风险**：修复器只做机械变换，修完可能仍有 facts/取舍问题（unrepairable 显式列出）；
  用户可能误以为「已修复=万事大吉」——UI 必须把剩余问题与事实覆盖放在同一屏。

## 替代方案（为什么没选）

| 方案                            | 否决理由                                                             |
| ------------------------------- | -------------------------------------------------------------------- |
| 只在 /verify 修，产品里不接     | 用户要自己搬 JSON；核验层永远是外挂演示，不是产品能力                |
| 修复直接自动写入（无确认）      | 违反「体检而非改写」红线；用户必须看到 before/after 再决定           |
| 另建 check 表/历史表            | 凭据可重算，只有「采纳事件」需要持久化；Plan JSON 足够，避免迁移成本 |
| 写入后不刷新 warnings           | 旧徽章与新判定矛盾，是比不修更糟的信任损伤                           |
| 让旧徽章改读 Trip Check（本轮） | 会牵动 PlanView/分享页全线，收益 < 风险；留作 S3                     |

## 参考

- 产品决策：[docs/PRODUCT-REVOLUTION-2026-10.md](../PRODUCT-REVOLUTION-2026-10.md) §3.2
- 判定标准：[docs/TRIP-CHECK-STANDARD.md](../TRIP-CHECK-STANDARD.md)
- 修复器：[ADR-013](013-trip-check-repair.md)、`lib/verify/repair.ts`
- 实现：`app/api/plan/check/`、`app/api/plan/repair/`、`components/WorkspaceCheck.tsx`
