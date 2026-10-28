// ============================================================
// Trip Check 规则注册表（口径的唯一权威）
//
// 为什么把规则元信息集中在这里：
// 1) 用户/第三方要能问「你凭什么说这条走不通」——规则 ID、说明、扣分、修复方向
//    必须是**可枚举、可版本化**的数据，而不是散落在 if 分支里的字符串；
// 2) API/MCP/文档/UI 共用同一份元信息，避免「页面说一套、接口说一套」；
// 3) penalty 只在结构轴生效：事实问题（地点不存在/闭馆）不改结构分，
//    它们由 facts 覆盖率与状态表达——两轴混算等于用一个数字掩盖不确定性。
//
// 规则分两类：
// - TC-Cxxx consistency：只靠文档自身就能判（时间轴/节奏/预算/重复/空天…）；
// - TC-Fxxx facts：依赖文档声明的来源与三态（存在性/营业时间/来源故障）。
//
// 严重度口径：
// - blocking：按文档给出的数据，这个行程走不通（时间重叠/接不上/闭馆/地点查不到）；
// - warning：能走但明显需要调整（节奏超限/绕路/预算超/重复点）；
// - info：信息不足或提示，不是行程的错（缺路段数据/未核验/来源故障）。
// ============================================================

import type { IssueSeverity, VerifyRuleMeta } from "./types";

export const RULES: Record<string, VerifyRuleMeta> = {
  // ---------- 结构自洽性 ----------
  "TC-C101": {
    id: "TC-C101",
    category: "consistency",
    severity: "warning",
    title: "时间格式无法解析",
    description: '点位的 time 不是合法的 "HH:MM-HH:MM"（或跨零点/零长），这一天的时间轴无法判定。',
    penalty: 3,
    fixHint: '改成 "HH:MM-HH:MM" 的同日时段（例如 "09:00-11:30"）。',
    since: "0.1.0",
  },
  "TC-C102": {
    id: "TC-C102",
    category: "consistency",
    severity: "blocking",
    title: "两段时间重叠",
    description: "相邻点位的时间段有重叠——按文档给出的时刻，物理上不可能同时出现在两个地方。",
    // 阻断级问题一次就足以让分数跌破 60（D）：分数与「能不能走」的语义必须一致
    penalty: 45,
    fixHint: "调整其中一个点的开始/结束时间，或把它移到下一天。",
    since: "0.1.0",
    mechanicalFix: "retime",
  },
  "TC-C103": {
    id: "TC-C103",
    category: "consistency",
    severity: "blocking",
    title: "时间接不上",
    description: "按文档给出的路段耗时，到达下一站时已经晚于它安排的开始时间。",
    penalty: 45,
    fixHint: "给这段路留足时间（或换更近的点位/把下一站顺延）。",
    since: "0.1.0",
    mechanicalFix: "retime",
  },
  "TC-C104": {
    id: "TC-C104",
    category: "consistency",
    severity: "info",
    title: "缺少真实路段数据",
    description:
      "相邻点位之间没有可用的路段耗时，无法判断「时间接不接得上」——这不是通过，只是不可判定。",
    penalty: 0,
    fixHint: "在文档里补 days[].legs（from/to/durationMin）后重新体检。",
    since: "0.1.0",
  },
  "TC-C105": {
    id: "TC-C105",
    category: "consistency",
    severity: "info",
    title: "关键字段缺失，部分判定已跳过",
    description: "缺少停留时长或花费时，节奏/预算判定无法完整进行；引擎不会用 0 补齐假装算过。",
    penalty: 0,
    fixHint: "补齐 durationMin / costCny 后重新体检。",
    since: "0.1.0",
  },
  "TC-C106": {
    id: "TC-C106",
    category: "consistency",
    severity: "warning",
    title: "当天通勤偏长",
    description: "当天点位间真实路段耗时合计超过阈值，常见原因是跨区安排或折返。",
    penalty: 8,
    fixHint: "合并同区域点位，或拆到两天。",
    since: "0.1.0",
  },
  "TC-C107": {
    id: "TC-C107",
    category: "consistency",
    severity: "warning",
    title: "节奏偏满",
    description: "当天停留时长（+真实通勤）超过所选节奏的日上限。",
    penalty: 6,
    fixHint: "删掉 1 个点，或把行程节奏改成更宽松的档位。",
    since: "0.1.0",
  },
  "TC-C108": {
    id: "TC-C108",
    category: "consistency",
    severity: "warning",
    title: "超出预算",
    description: "文档给出的花费合计超过人均预算（允许 5% 弹性，与产品内口径一致）。",
    penalty: 3,
    fixHint: "换掉高价项目，或调高预算。",
    since: "0.1.0",
  },
  "TC-C109": {
    id: "TC-C109",
    category: "consistency",
    severity: "warning",
    title: "同一天重复点位",
    description: "同一天出现多个同名点位，通常是生成/复制时的重复条目。",
    penalty: 5,
    fixHint: "删掉重复项，或把它们合并成一次停留。",
    since: "0.1.0",
    mechanicalFix: "dedupe",
  },
  "TC-C110": {
    id: "TC-C110",
    category: "consistency",
    severity: "warning",
    title: "空白天",
    description: "某一天没有任何点位——行程在这天是空转的。",
    penalty: 5,
    fixHint: "给这天补一个点位，或把行程天数缩短。",
    since: "0.1.0",
  },
  "TC-C111": {
    id: "TC-C111",
    category: "consistency",
    severity: "warning",
    title: "同一天点位分散",
    description:
      "当天景点跨过多个不同区域，且没有路段数据可证明通勤可行——绕路与折返的概率明显增加。",
    penalty: 5,
    fixHint: "把同区域的点合并在同一天，或补路段数据重新判定。",
    since: "0.1.0",
  },

  // ---------- 事实核验 ----------
  "TC-F201": {
    id: "TC-F201",
    category: "facts",
    severity: "info",
    title: "地点未核验",
    description:
      "文档没有声明这些地点的存在性核验结果。未核验 ≠ 不存在，也 ≠ 有问题——是「不知道」。",
    penalty: 0,
    fixHint: "在 verification.existence 里声明 hit/miss，或接入事实源重新核验。",
    since: "0.1.0",
  },
  "TC-F202": {
    id: "TC-F202",
    category: "facts",
    severity: "blocking",
    title: "地点未命中",
    description: "事实源查不到该地点（名称有误/已关闭/来源无覆盖）。",
    penalty: 0,
    fixHint: "核对名称与叫法，或换成事实源能查到的点位。",
    since: "0.1.0",
  },
  "TC-F203": {
    id: "TC-F203",
    category: "facts",
    severity: "info",
    title: "营业时间未核验",
    description: "没有可用的营业时间数据（未查/来源没有/解析不了），引擎不会假装知道它几点开门。",
    penalty: 0,
    fixHint: "在 verification.hours 与 hours 原文里补上来源数据。",
    since: "0.1.0",
  },
  "TC-F204": {
    id: "TC-F204",
    category: "facts",
    severity: "blocking",
    title: "营业时间对不上",
    description: "按文档给出的营业时间原文与日期，这个到达时段闭馆或不在营业时间内。",
    penalty: 0,
    fixHint: "换一天/换时间段，或确认当天是否临时开放（以官方公告为准）。",
    since: "0.1.0",
  },
  "TC-F205": {
    id: "TC-F205",
    category: "facts",
    severity: "info",
    title: "核验源故障",
    description: "事实源查询失败（上游波动/限流/超时）。这是「不知道」，不能算「地点不存在」。",
    penalty: 0,
    fixHint: "稍后重试核验；报告里应把这条与 miss 区分对待。",
    since: "0.1.0",
  },
};

/** 稳定顺序（文档/UI 按它排；不依赖对象 key 顺序） */
export const RULE_ORDER: string[] = Object.keys(RULES);

/** 规则集版本对应的规则 ID 清单（报告 ruleset 字段用） */
export const RULE_IDS: string[] = RULE_ORDER;

/** 严重度排序权重（blocking 最前） */
export const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  blocking: 0,
  warning: 1,
  info: 2,
};
