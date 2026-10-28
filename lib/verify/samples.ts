// ============================================================
// Trip Check 示例文档（公开 playground / 测试 / 文档共用）
//
// 为什么示例要「三种状态各一份」：开放标准的演示最容易犯的错是只给一份
// A 级样例，让人以为「体检通过 = 万事大吉」。这里刻意给三类：
// 1) verified：结构干净 + 事实全部核验（A 级 + verified）——证明结论长什么样；
// 2) blocked：真实世界里常见的生成错误（时间重叠/闭馆/查不到地点）——证明它抓得住；
// 3) unverified：结构 OK 但没有任何事实来源——证明我们不拿「没核验」冒充「没问题」。
//
// 注意：示例里的营业时间是**人工写的示意数据**（不是真实抓取），用于演示格式与
// 判定逻辑；它们不构成任何真实世界的营业时间承诺（页面也这么写）。
// ============================================================

import { TRIP_CHECK_SPEC_VERSION, type TripCheckDocument } from "./types";

export interface TripCheckSample {
  id: "verified" | "blocked" | "unverified";
  label: string;
  /** 一句话说明这份示例想展示什么 */
  description: string;
  document: TripCheckDocument;
}

/** 示例 1：结构干净 + 事实全部核验（预期：A 级 + facts verified） */
const VERIFIED: TripCheckDocument = {
  specVersion: TRIP_CHECK_SPEC_VERSION,
  id: "sample_verified",
  city: "苏州",
  budgetCny: 900,
  provenance: {
    poi: { source: "amap", checkedAt: "2026-10-27T10:00:00.000Z" },
    routes: { source: "amap", checkedAt: "2026-10-27T10:00:00.000Z" },
    hours: { source: "amap", checkedAt: "2026-10-27T10:00:00.000Z" },
  },
  days: [
    {
      day: 1,
      date: "2026-11-03",
      spots: [
        {
          name: "拙政园",
          time: "09:00-11:00",
          type: "sight",
          durationMin: 120,
          costCny: 80,
          area: "姑苏区",
          location: "120.629,31.324",
          hours: { openTime: "周一至周日 07:30-17:30" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "平江路",
          time: "11:30-13:00",
          type: "sight",
          durationMin: 90,
          costCny: 60,
          area: "姑苏区",
          location: "120.631,31.317",
          hours: { openTime: "24小时营业" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "苏州博物馆",
          time: "14:00-16:30",
          type: "sight",
          durationMin: 150,
          costCny: 0,
          area: "姑苏区",
          location: "120.628,31.322",
          hours: { openTime: "周二至周日 09:00-17:00" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
      ],
      legs: [
        { from: "拙政园", to: "平江路", mode: "walking", durationMin: 20, distanceM: 1300 },
        { from: "平江路", to: "苏州博物馆", mode: "walking", durationMin: 15, distanceM: 1000 },
      ],
    },
    {
      day: 2,
      date: "2026-11-04",
      spots: [
        {
          name: "虎丘",
          time: "09:30-12:00",
          type: "sight",
          durationMin: 150,
          costCny: 70,
          area: "姑苏区",
          location: "120.576,31.338",
          hours: { openTime: "周一至周日 07:30-17:30" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "山塘街",
          time: "13:30-16:00",
          type: "sight",
          durationMin: 150,
          costCny: 50,
          area: "姑苏区",
          location: "120.594,31.323",
          hours: { openTime: "24小时营业" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
      ],
      legs: [{ from: "虎丘", to: "山塘街", mode: "driving", durationMin: 18, distanceM: 3500 }],
    },
  ],
};

/** 示例 2：常见的 AI 生成错误（预期：blocking + D 级；含闭馆/重叠/未命中/缺路段） */
const BLOCKED: TripCheckDocument = {
  specVersion: TRIP_CHECK_SPEC_VERSION,
  id: "sample_blocked",
  city: "苏州",
  budgetCny: 300,
  provenance: { poi: { source: "amap", checkedAt: "2026-10-27T10:00:00.000Z" } },
  days: [
    {
      day: 1,
      date: "2026-11-02", // 周一：苏州博物馆周一闭馆
      spots: [
        {
          name: "苏州博物馆",
          time: "09:00-12:00",
          type: "sight",
          durationMin: 180,
          costCny: 0,
          area: "姑苏区",
          hours: { openTime: "周一闭馆；周二至周日 09:00-17:00" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "平江路",
          time: "11:30-13:00", // 与上一站重叠 30 分钟
          type: "sight",
          durationMin: 90,
          costCny: 60,
          area: "姑苏区",
          location: "120.631,31.317",
          hours: { openTime: "24小时营业" },
          verification: { source: "amap", existence: "hit", hours: "hit" },
        },
        {
          name: "金鸡湖美术馆",
          time: "14:00-16:00",
          type: "sight",
          durationMin: 120,
          costCny: 200,
          area: "工业园区",
          verification: { source: "amap", existence: "miss", hours: "miss" },
        },
      ],
      // 故意不给 legs：无法判断时间是否接得上（C104），而不是假装判过
    },
  ],
};

/** 示例 3：结构自洽但没有任何事实来源（预期：A 级 + facts unverified） */
const UNVERIFIED: TripCheckDocument = {
  specVersion: TRIP_CHECK_SPEC_VERSION,
  id: "sample_unverified",
  city: "杭州",
  days: [
    {
      day: 1,
      date: "2026-11-04",
      spots: [
        {
          name: "西湖断桥",
          time: "09:00-10:30",
          type: "sight",
          durationMin: 90,
          costCny: 0,
          area: "西湖区",
        },
        {
          name: "灵隐寺",
          time: "11:00-13:00",
          type: "sight",
          durationMin: 120,
          costCny: 75,
          area: "西湖区",
        },
      ],
      // 没有 legs：无法判断通勤（C104）
    },
  ],
};

export const TRIP_CHECK_SAMPLES: readonly TripCheckSample[] = [
  {
    id: "verified",
    label: "已核验行程（苏州 2 天）",
    description: "结构自洽 + 事实全部核验：预期 A 级、facts=verified。",
    document: VERIFIED,
  },
  {
    id: "blocked",
    label: "有问题的行程（闭馆/重叠）",
    description: "AI 常见错误：周一排闭馆、时间重叠、地点查不到——预期 blocking。",
    document: BLOCKED,
  },
  {
    id: "unverified",
    label: "未核验行程（杭州 1 天）",
    description: "结构没问题但没有任何事实来源：结构 A 级、facts=unverified——两轴分开看。",
    document: UNVERIFIED,
  },
];

export function getSample(id: string): TripCheckSample | undefined {
  return TRIP_CHECK_SAMPLES.find((s) => s.id === id);
}
