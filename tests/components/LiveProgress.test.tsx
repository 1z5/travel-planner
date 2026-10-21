import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiveProgress } from "@/components/LiveProgress";
import type { Plan, PlanDay, PlanSpot, SpotType } from "@/lib/types";

// 切片5 · 流式生长体验：等待期组件测试。
//
// 钉住的契约（与任务规格一一对应）：
// 1. 流式阶段清单：到达节点打勾、当前节点动画、day:N/M 徽章（真实 N/M）
// 2. 天数生长：plan.days 有几张就渲染几张卡，DAY 编号 + 主题 + 站名
// 3. 诚实：单次路径（草稿 draft=true）只画不确定条、不渲染「已生成」天数卡
// 4. 验真徽章只报真实状态：pending=已逐点核验 / mock=明说未逐点验真 / 无字段不出徽章
// 5. 降级：无 stage 遥测 → WaitProgress 骨架（不确定条），不猜阶段

function spot(name: string, type: SpotType = "sight"): PlanSpot {
  return {
    period: "morning",
    time: "09:00-11:00",
    type,
    name,
    area: "测试区",
    durationMin: 120,
    costCny: 60,
    reason: "测试",
  };
}

function day(n: number, theme: string, spots: PlanSpot[] = [spot(`第 ${n} 天景点A`)]): PlanDay {
  return { day: n, theme, spots, transitMin: 30, dailyCostCny: 300 };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    city: "成都",
    summary: "5 天行程",
    days: [],
    totalCostCny: 0,
    tips: [],
    warnings: [],
    verified: false,
    ...overrides,
  };
}

/** 阶段节点的 class 状态（done=打勾 / active=当前 / 空=待办） */
function stageStates(container: HTMLElement): string[][] {
  return [...container.querySelectorAll(".live-stage")].map((li) =>
    [
      li.className.includes("done") ? "done" : "",
      li.className.includes("active") ? "active" : "",
    ].filter(Boolean),
  );
}

describe("LiveProgress 流式阶段清单（≥5 天）", () => {
  it("day:2/5：大纲/取事实打勾，逐日生成为当前节点并带 2/5 徽章，收尾待办", () => {
    const { container } = render(
      <LiveProgress
        stage="day:2/5"
        plan={makePlan({ days: [day(1, "第一天"), day(2, "第二天")] })}
        submittedDays={5}
        elapsed="1:30"
      />,
    );
    expect(stageStates(container)).toEqual([["done"], ["done"], ["active"], []]);
    expect(screen.getByText("2/5 天")).toBeInTheDocument();
    expect(screen.getByText("逐日生成")).toBeInTheDocument();
  });

  it("确定性进度：已生成 2/5 天 → 40% 宽度（真实 N/M，不猜百分比）", () => {
    const { container } = render(
      <LiveProgress
        stage="day:2/5"
        plan={makePlan({ days: [day(1, "第一天"), day(2, "第二天")] })}
        submittedDays={5}
        elapsed="1:30"
      />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    const fill = container.querySelector(".wait-bar-fill");
    expect(fill).not.toHaveClass("indeterminate");
    expect(fill?.getAttribute("style")).toContain("width: 40%");
    expect(screen.getByText("已生成 2/5 天")).toBeInTheDocument();
  });

  it("day:0/5（大纲/取事实中）：确定性 0%——如实报 0，不假装进度", () => {
    const { container } = render(
      <LiveProgress stage="grounding" plan={makePlan()} submittedDays={5} elapsed="0:20" />,
    );
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(container.querySelector(".wait-bar-fill")).not.toHaveClass("indeterminate");
  });

  it("finalizing：最后一个节点为当前，其余全部打勾", () => {
    const { container } = render(
      <LiveProgress
        stage="finalizing"
        plan={makePlan({ days: [day(1, "第一天")] })}
        submittedDays={5}
        elapsed="4:00"
      />,
    );
    expect(stageStates(container)).toEqual([["done"], ["done"], ["done"], ["active"]]);
  });

  it("stage=outline（流式第一帧，plan 还没落库）：走流式节点清单", () => {
    const { container } = render(<LiveProgress stage="outline" submittedDays={5} elapsed="0:05" />);
    expect(screen.getByText("大纲成形")).toBeInTheDocument();
    expect(stageStates(container)).toEqual([["active"], [], [], []]);
  });
});

describe("LiveProgress 天数生长上屏", () => {
  it("plan.days 有几天渲染几张卡：DAY 编号 + 主题 + 站名", () => {
    const plan = makePlan({
      days: [day(1, "市区园林日", [spot("拙政园"), spot("平江路", "food")]), day(2, "山水古镇日")],
    });
    const { container } = render(
      <LiveProgress stage="day:2/5" plan={plan} submittedDays={5} elapsed="2:00" />,
    );
    const cards = container.querySelectorAll(".live-day");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("拙政园");
    expect(cards[0].textContent).toContain("平江路");
    expect(cards[0].textContent).toContain("市区园林日");
    expect(cards[1].textContent).toContain("山水古镇日");
    expect(cards[1].textContent).toContain("第 2 天景点A");
  });

  it("没有已生成的天（骨架态）：不渲染天数卡", () => {
    const { container } = render(
      <LiveProgress stage="day:0/5" plan={makePlan()} submittedDays={5} elapsed="0:30" />,
    );
    expect(container.querySelectorAll(".live-day")).toHaveLength(0);
  });

  it("单站超过 5 个：折叠为「还有 N 站」（卡片是预览，不铺全量）", () => {
    const many = Array.from({ length: 8 }, (_, i) => spot(`站点${i + 1}`));
    const { container } = render(
      <LiveProgress
        stage="day:1/5"
        plan={makePlan({ days: [day(1, "第一天", many)] })}
        submittedDays={5}
        elapsed="1:00"
      />,
    );
    expect(container.querySelectorAll(".live-day-spots li")).toHaveLength(6); // 5 站 + 折叠行
    expect(screen.getByText("还有 3 站…")).toBeInTheDocument();
  });
});

describe("LiveProgress 验真状态徽章（只报真实状态）", () => {
  it("pending：已逐点核验（当天发布前已过 validateDay 的逐点验真）", () => {
    render(
      <LiveProgress
        stage="day:1/5"
        plan={makePlan({ days: [day(1, "第一天")], verification: "pending" })}
        submittedDays={5}
        elapsed="1:00"
      />,
    );
    expect(screen.getByText("已逐点核验")).toBeInTheDocument();
  });

  it("mock：明说「MOCK 模式 · 未逐点验真」——不拿 pending 冒充已核验", () => {
    render(
      <LiveProgress
        stage="day:1/5"
        plan={makePlan({ days: [day(1, "第一天")], verification: "mock" })}
        submittedDays={5}
        elapsed="1:00"
      />,
    );
    expect(screen.getByText("MOCK 模式 · 未逐点验真")).toBeInTheDocument();
  });

  it("旧数据无 verification 字段：不出徽章（不猜）", () => {
    render(
      <LiveProgress
        stage="day:1/5"
        plan={makePlan({ days: [day(1, "第一天")] })}
        submittedDays={5}
        elapsed="1:00"
      />,
    );
    expect(document.querySelector(".live-day-badge")).toBeNull();
  });
});

describe("LiveProgress 单次路径（≤4 天，诚实：拿不到就不假装）", () => {
  it("generating：单次路径节点清单（取事实/生成行程/逐点核验/收尾）+ 不确定动画条", () => {
    const draft = makePlan({
      draft: true,
      days: [day(1, "第一天"), day(2, "第二天"), day(3, "第三天")],
    });
    const { container } = render(
      <LiveProgress stage="generating" plan={draft} submittedDays={3} elapsed="1:00" />,
    );
    // 草稿天数不是生成天数：不确定条 + 不渲染天数卡
    expect(container.querySelector(".wait-bar-fill")).toHaveClass("indeterminate");
    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(container.querySelectorAll(".live-day")).toHaveLength(0);
    // 当前节点是「生成行程」（真正的长等待），取事实已打勾
    expect(stageStates(container)).toEqual([["done"], ["active"], [], []]);
    expect(screen.getByText("推理模型推演预算、动线与节奏（通常 2-4 分钟）")).toBeInTheDocument();
  });

  it("verify：逐点核验为当前节点（POI 验真 + 体检进行中）", () => {
    const draft = makePlan({ draft: true });
    const { container } = render(
      <LiveProgress stage="verify" plan={draft} submittedDays={3} elapsed="3:00" />,
    );
    expect(stageStates(container)).toEqual([["done"], ["done"], ["active"], []]);
    expect(container.querySelector(".wait-bar-fill")).toHaveClass("indeterminate");
  });
});

describe("LiveProgress 降级（无遥测）", () => {
  it("stage 缺失（旧任务）：WaitProgress 骨架 + 不确定条，不猜阶段", () => {
    const { container } = render(<LiveProgress submittedDays={5} elapsed="0:40" />);
    expect(container.querySelector(".wait-bar-fill")).toHaveClass("indeterminate");
    expect(container.querySelector(".live-stages")).toBeNull();
    expect(screen.getByText("已等待 0:40")).toBeInTheDocument();
  });

  it("降级态也沿用原口径：非草稿（流式旧任务）有真实天数 → 确定性条", () => {
    const oldStream = makePlan({ days: [day(1, "第一天"), day(2, "第二天")] }); // 无 draft 标记
    render(<LiveProgress plan={oldStream} submittedDays={5} elapsed="1:10" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("已生成 2/5 天")).toBeInTheDocument();
  });
});
