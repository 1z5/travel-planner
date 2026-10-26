// ⚠️ 本文件由 scripts/demo-gen.mjs 自动生成，请勿手改。
// 为什么用静态 import 而不是 fs.readdir：Next standalone 的产物只包含被静态
// import 追踪到的文件——fixture 要随镜像/部署产物一起走，必须静态引用。
import type { Plan, PlanInput } from "@/lib/types";

import case0 from "./chengdu-4d.json";
import case1 from "./suzhou-3d.json";

/** 一条演示行程（真实生成产物：真实 POI/营业时间/通勤） */
export interface DemoFixture {
  /** 稳定的分享 token：重启/冷启动后同一个链接依然有效（fixture 在仓库里） */
  shareId: string;
  /** 生成时的原始输入：克隆/继续编辑/分享页展示都要 */
  input: PlanInput;
  plan: Plan;
  generatedAt: string;
  label: string;
}

export const DEMO_FIXTURES: DemoFixture[] = [
  case0 as unknown as DemoFixture,
  case1 as unknown as DemoFixture,
];
