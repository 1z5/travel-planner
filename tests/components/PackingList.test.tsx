import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PackingList } from "@/components/PackingList";
import type { Plan } from "@/lib/types";
import { derivePackingList } from "@/lib/packing";

// 出发前准备卡：钉住「每项带依据与来源」「空清单如实说明」两条红线。

const plan: Plan = {
  city: "苏州",
  summary: "测试",
  days: [
    {
      day: 1,
      theme: "园林",
      spots: [
        {
          period: "evening",
          time: "19:00-20:30",
          type: "sight",
          name: "七里山塘",
          area: "姑苏区",
          durationMin: 90,
          costCny: 0,
          reason: "夜游",
          rainBackup: "室内备选",
        },
      ],
      transitMin: 0,
      dailyCostCny: 0,
    },
    { day: 2, theme: "古镇", spots: [], transitMin: 0, dailyCostCny: 0 },
    { day: 3, theme: "水乡", spots: [], transitMin: 0, dailyCostCny: 0 },
  ],
  totalCostCny: 1000,
  tips: ["博物馆需要提前实名预约"],
  warnings: [],
  verified: true,
};

describe("PackingList", () => {
  it("渲染推导项：标签 + 依据 + 来源 + 天气降级说明", () => {
    render(<PackingList plan={plan} />);
    expect(screen.getByText("出发前准备")).toBeInTheDocument();
    // 三项证据：室外（防晒）、晚间（充电宝）、3 天（健康）
    expect(screen.getByText("防晒与遮阳")).toBeInTheDocument();
    expect(screen.getByText("充电宝")).toBeInTheDocument();
    expect(screen.getByText("常用药与换洗衣物")).toBeInTheDocument();
    expect(screen.getByText(/未接入实时天气/)).toBeInTheDocument();
    // 来源可溯源：显示到具体天与点位。
    // 同一个点可能同时命中多条规则（室外 + 晚间），所以用 getAllByText。
    expect(screen.getAllByText(/第 1 天 · 七里山塘/).length).toBeGreaterThan(0);
  });

  it("空清单：如实说明不凑通用条目，不渲染列表", () => {
    const indoor: Plan = {
      ...plan,
      days: [{ day: 1, theme: "博物馆", spots: [], transitMin: 0, dailyCostCny: 0 }],
      tips: [],
    };
    render(<PackingList plan={indoor} />);
    expect(screen.getByText(/没有推导出特定的准备项/)).toBeInTheDocument();
    expect(screen.queryByText("防晒与遮阳")).not.toBeInTheDocument();
  });
});

describe("PackingList 默认折叠（长页面减滚动）", () => {
  it("默认 closed，summary 显示条数与「展开查看」；展开后条目/依据/来源仍在", async () => {
    const { container } = render(<PackingList plan={plan} />);
    const details = container.querySelector("details.packing-details");
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);

    const summary = screen.getByText(/出发前准备/).closest("summary")!;
    expect(summary.textContent).toMatch(/出发前准备/);
    expect(summary.textContent).toContain(`${derivePackingList(plan).length} 项`);
    expect(summary.textContent).toMatch(/展开查看/);

    await userEvent.click(summary);
    expect((details as HTMLDetailsElement).open).toBe(true);
    // 展开后信息量不变：标签 + 依据 + 来源 + 天气降级说明
    expect(screen.getByText("防晒与遮阳")).toBeInTheDocument();
    expect(screen.getAllByText(/室外景点/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/第 1 天 · 七里山塘/).length).toBeGreaterThan(0);
    expect(screen.getByText(/未接入实时天气/)).toBeInTheDocument();
  });

  it("空清单：summary 如实写「无特定准备项」，展开后仍有空态说明", async () => {
    const indoor: Plan = {
      ...plan,
      days: [{ day: 1, theme: "博物馆", spots: [], transitMin: 0, dailyCostCny: 0 }],
      tips: [],
    };
    const { container } = render(<PackingList plan={indoor} />);
    const summary = container.querySelector("summary.packing-summary")!;
    expect(summary.textContent).toMatch(/无特定准备项/);
    await userEvent.click(summary);
    expect(screen.getByText(/没有推导出特定的准备项/)).toBeInTheDocument();
  });
});
