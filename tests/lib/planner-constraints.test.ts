import { describe, expect, it } from "vitest";
import { constraintProblem } from "@/lib/planner";
import { SAMPLE_PLAN } from "@/lib/sample-plan";
import type { Plan, PlanInput } from "@/lib/types";

// 硬约束核对：用户明确说的话必须进行程。
//
// 线上实测踩过（香港穷游那次）：必游地「兰桂坊」因为 UI 选中建议只填输入框
// 没入库，请求里根本没有这项；住所「大冲城市花园」被模型自己换成了深圳湾口岸。
// 两类都属于「文档写着硬约束、实际只给一句告警」——这里在生成侧兜住。

function input(over: Partial<PlanInput> = {}): PlanInput {
  return {
    city: "香港",
    days: 1,
    startAt: "2026-11-01T09:00",
    endAt: "2026-11-01T20:00",
    budget: 0,
    preferences: [],
    ...over,
  } as PlanInput;
}

function planWith(names: string[]): Plan {
  const p = structuredClone(SAMPLE_PLAN);
  p.days = p.days.slice(0, 1).map((d) => ({
    ...d,
    spots: names.map((n, i) => ({
      ...d.spots[0],
      name: n,
      time: `0${i}:00-1${i}:00`,
    })),
  }));
  return p;
}

describe("硬约束核对（constraintProblem）", () => {
  it("必游地缺失：返回要回灌的纠正指令，并点名缺失项", () => {
    const p = constraintProblem(
      planWith(["九龙公园", "星光大道"]),
      input({ mustVisit: ["兰桂坊"] }),
    );
    expect(p).toContain("兰桂坊");
    expect(p).toContain("排进行程");
  });

  it("必游地已安排（含名称变体）：合格", () => {
    // 用户写简称、模型落成全称是正确执行：coveredBy 双向包含要能认出来
    expect(
      constraintProblem(planWith(["兰桂坊(中环)", "九龙公园"]), input({ mustVisit: ["兰桂坊"] })),
    ).toBeNull();
  });

  it("住所未作出发点：返回纠正指令（第一站必须从住所出发）", () => {
    const p = constraintProblem(
      planWith(["深圳湾口岸", "九龙公园"]),
      input({ hotel: "大冲城市花园" }),
    );
    expect(p).toContain("大冲城市花园");
    expect(p).toContain("出发点");
  });

  it("住所在地与目的地不同城：指令要求先写城际段且不编造通勤分钟数", () => {
    const p = constraintProblem(planWith(["九龙公园"]), input({ hotel: "大冲城市花园" }));
    expect(p).toContain("与目的地不同城");
    expect(p).toContain("不要写具体分钟数");
  });

  it("住所已作为第一站出现：合格", () => {
    expect(
      constraintProblem(
        planWith(["大冲城市花园→深圳湾口岸", "九龙公园"]),
        input({ hotel: "大冲城市花园" }),
      ),
    ).toBeNull();
  });

  it("别名/模糊写法不算缺失（避免白烧一次生成调用）", () => {
    // 「苏博」↔「苏州博物馆」、「住平江附近」↔「平江历史街区」都应判已安排
    expect(constraintProblem(planWith(["苏州博物馆"]), input({ mustVisit: ["苏博"] }))).toBeNull();
    expect(
      constraintProblem(planWith(["平江历史街区"]), input({ hotel: "住平江附近" })),
    ).toBeNull();
  });

  it("都没有问题时返回 null（不产生无意义重试）", () => {
    expect(
      constraintProblem(
        planWith(["兰桂坊", "大冲城市花园"]),
        input({
          mustVisit: ["兰桂坊"],
          hotel: "大冲城市花园",
        }),
      ),
    ).toBeNull();
  });
});
