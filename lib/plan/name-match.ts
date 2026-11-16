// ============================================================
// 名称匹配的唯一实现（client-safe 纯函数）。
//
// 【为什么有这一模块】（重构 ADR-020 · R5）
// 收敛前同一规则有三份：schedule.ts 的 namesMatch（固定活动锚点识别）、
// replan.ts 的 matchSpotName（重排时认锚点）、validate.ts 的
// longestCommonSubstring + nameCovered（必游地/住所覆盖判定）。三份
// 注释都写着「改阈值时两处必须一起改」——3 字阈值是校准值（「武侯祠」
// 这类三字地名要能命中，而「测试必游地X」与 fixture 各 POI 的公共子串
// 仅 1 字，不会把漏排误放过），漂移任何一处都会让「用户写简称、模型落
// 全称」的正确执行被误报成「未出现在行程中」——预警系统说谎。
//
// 规则（任一命中即算匹配）：
// 1. 双向完整包含——用户给了确切名称，或模型用了更短的规范名；
// 2. 最长公共子串 ≥3 字——用户写简称/别称，模型补全了场馆或全称。
// ============================================================

/**
 * 两个字符串的最长公共子串长度（字符级，动态规划）。
 * 地名/活动名都在 30 字内，短串足够快，不需要后缀自动机那类复杂结构。
 */
export function longestCommonSubstring(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = Array.from<number>({ length: b.length + 1 }).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    const cur = Array.from<number>({ length: b.length + 1 }).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/**
 * 行程点名称与活动/锚点名称是否指同一个地点。
 * 用户写简称、行程落成全称是正确执行，必须能被锚点识别出来
 * （「川剧变脸」↔「蜀风雅韵川剧变脸演出(琴台路店)」）。
 */
export function matchSpotName(spotName: string, anchorName: string): boolean {
  const x = String(spotName ?? "").trim();
  const y = String(anchorName ?? "").trim();
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return longestCommonSubstring(x, y) >= 3;
}

/**
 * 用户写的名字是否已被行程覆盖（必游地/住所核验用）。
 *
 * 为什么不能只用全字符串 includes：用户写「成都川剧变脸演出」，模型会
 * **正确**落成具体场馆「蜀风雅韵川剧变脸演出(琴台路店)」——全串匹配
 * 不上就把正确执行误报成「未出现在行程中」。必游地同样：「成都大熊猫
 * 基地」vs 模型落成的「成都大熊猫繁育研究基地」。
 */
export function nameCovered(name: string, candidates: readonly string[]): boolean {
  const n = name.trim();
  if (!n) return false;
  return candidates.some((c) => {
    if (c.includes(n) || n.includes(c)) return true;
    return longestCommonSubstring(n, c) >= 3;
  });
}
