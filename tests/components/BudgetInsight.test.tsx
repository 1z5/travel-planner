import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BudgetInsight } from "@/components/BudgetInsight";
import { summarizeBudget } from "@/lib/budget";
import type { Plan, PlanSpot, SpotType } from "@/lib/types";

// 预算透视卡组件测试：钉住 Props 契约（BudgetSummary 进、UI 出）、
// 进度条的无障碍语义、以及「无预算/空数据」的优雅降级。
// summary 用真实 summarizeBudget 生成（不是手写对象）——组件的渲染契约
// 必须和 lib 的真实输出对得上，否则集成时会静默错位。

function spot(type: SpotType | string, costCny: number, name = "测试点"): PlanSpot {
  return {
    period: "morning",
    time: "09:00-10:00",
    type: type as SpotType,
    name,
    area: "测试区",
    durationMin: 60,
    costCny,
    reason: "单测用",
  };
}

function makePlan(
  days: Array<{ day?: number; spots: PlanSpot[] }>,
  opts: { budgetCny?: number } = {},
): Plan {
  const planDays = days.map((d, i) => ({
    day: d.day ?? i + 1,
    theme: `第 ${i + 1} 天`,
    spots: d.spots,
    transitMin: 0,
    dailyCostCny: d.spots.reduce((s, x) => s + x.costCny, 0),
  }));
  return {
    city: "测试城",
    summary: "测试行程",
    days: planDays,
    totalCostCny: planDays.reduce((s, d) => s + d.dailyCostCny, 0),
    tips: [],
    warnings: [],
    verified: true,
    ...(opts.budgetCny !== undefined ? { budgetCny: opts.budgetCny } : {}),
  };
}

// 六类别齐全的行程：总额 1800
const fullPlan = (budgetCny?: number) =>
  makePlan(
    [
      {
        spots: [
          spot("hotel", 1200, "酒店"),
          spot("food", 400, "餐厅"),
          spot("sight", 100, "景点"),
          spot("transport", 50, "打车"),
          spot("shopping", 30, "特产"),
          spot("activity", 20, "演出"),
        ],
      },
    ],
    { budgetCny },
  );

const toneClass = (container: HTMLElement) =>
  container.querySelector(".budget-insight")?.className ?? "";

describe("BudgetInsight", () => {
  it("有预算：渲染预算/已用/百分比 + 进度条 + 状态文案", () => {
    const { container } = render(
      <BudgetInsight
        summary={summarizeBudget(makePlan([{ spots: [spot("food", 1120)] }], { budgetCny: 1000 }))}
      />,
    );
    expect(container.textContent).toContain("预算");
    expect(container.textContent).toContain("¥1,000");
    expect(container.textContent).toContain("¥1,120");
    expect(container.textContent).toContain("112%");
    expect(screen.getByText("超出预算")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("超支：红色语义类名 + 进度条填满 + 无障碍值被夹取在 0-100", () => {
    const { container } = render(
      <BudgetInsight
        summary={summarizeBudget(
          makePlan([{ spots: [spot("hotel", 1200), spot("food", 320)] }], { budgetCny: 1000 }),
        )}
      />,
    );
    const root = container.querySelector(".budget-insight");
    expect(root?.className).toContain("budget-tone-err");
    expect(root?.getAttribute("data-status")).toBe("over");
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // 超支 152% 时 now 仍夹到 100（进度条语义是「预算用了多少」）
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "已用预算 152%");
    const fill = container.querySelector(".budget-progress-fill");
    expect(fill?.getAttribute("style")).toContain("width: 100%");
    // 人话结论：notes[0]
    expect(container.textContent).toContain("比预算多");
  });

  it("无预算：不画进度条，显示人均总花费 + 分类构成 + 最大开销结论", () => {
    const { container } = render(<BudgetInsight summary={summarizeBudget(fullPlan())} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.textContent).toContain("人均总花费");
    expect(container.textContent).toContain("¥1,800");
    expect(toneClass(container)).toContain("budget-tone-muted");
    // 类别图例：label + 金额 + 占比
    for (const label of ["住宿", "餐饮", "景点门票", "交通", "购物", "体验活动"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain("¥1,200");
    expect(container.textContent).toContain("67%");
    // 结论讲「钱花在哪」而不是编一个使用率
    expect(container.textContent).toContain("是最大开销");
    expect(container.textContent).not.toContain("已用");
  });

  it("分类堆叠条：按类别分段、有 aria-label 描述、色块数量与类别一致", () => {
    const { container } = render(<BudgetInsight summary={summarizeBudget(fullPlan(1800))} />);
    const stack = screen.getByRole("img", { name: /花费构成/ });
    expect(stack.getAttribute("aria-label")).toContain("住宿");
    expect(stack.getAttribute("aria-label")).toContain("餐饮");
    expect(container.querySelectorAll(".budget-stack-seg").length).toBe(6);
    expect(container.querySelectorAll(".budget-legend-item").length).toBe(6);
    // 色块走类别固定色（内联 style 只承载运行时色值）
    const swatch = container.querySelector(".budget-swatch");
    expect(swatch?.getAttribute("style")).toContain("background");
  });

  it("达标：绿色语义类名 + 预算达标文案", () => {
    const { container } = render(
      <BudgetInsight
        summary={summarizeBudget(makePlan([{ spots: [spot("food", 830)] }], { budgetCny: 1000 }))}
      />,
    );
    expect(toneClass(container)).toContain("budget-tone-ok");
    expect(screen.getByText("预算达标")).toBeInTheDocument();
    expect(container.textContent).toContain("在预算内");
  });

  it("宽松：黄色语义类名 + 预算宽松文案", () => {
    const { container } = render(
      <BudgetInsight
        summary={summarizeBudget(makePlan([{ spots: [spot("food", 500)] }], { budgetCny: 1000 }))}
      />,
    );
    expect(toneClass(container)).toContain("budget-tone-warn");
    expect(screen.getByText("预算宽松")).toBeInTheDocument();
    expect(container.textContent).toContain("可升级住宿或加一个体验");
  });

  it("占比不足 1% 的类别显示「<1%」，金额仍如实展示", () => {
    const { container } = render(
      <BudgetInsight
        summary={summarizeBudget(makePlan([{ spots: [spot("hotel", 1999), spot("food", 1)] }]))}
      />,
    );
    expect(container.textContent).toContain("<1%");
    expect(container.textContent).toContain("¥1");
  });

  it("空行程：不崩、不画进度条/堆叠条，结论如实说明没有花费", () => {
    const { container } = render(<BudgetInsight summary={summarizeBudget(makePlan([]))} />);
    expect(container.querySelector(".budget-insight")).not.toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(container.querySelector(".budget-stack")).toBeNull();
    expect(container.textContent).toContain("没有记录花费");
  });
});
