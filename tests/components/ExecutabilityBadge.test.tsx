import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Plan } from "@/lib/types";
import { ExecutabilityBadge } from "@/components/ExecutabilityBadge";

// 评分卡的显示口径：已核验给 A/B/C/D + 分数；MOCK 不评假分；生成中不猜。

function spot(name: string) {
  return {
    period: "morning" as const,
    time: "09:00-10:30",
    type: "sight" as const,
    name,
    area: "姑苏区",
    durationMin: 90,
    costCny: 80,
    reason: "经典园林",
    location: "120.6,31.3",
  };
}

function plan(over: Partial<Plan> = {}): Plan {
  return {
    city: "苏州",
    summary: "3 天古城园林",
    days: [{ day: 1, theme: "古城", spots: [spot("拙政园")], transitMin: 0, dailyCostCny: 300 }],
    totalCostCny: 1000,
    tips: [],
    warnings: [],
    verified: true,
    verification: "ok",
    ...over,
  };
}

describe("ExecutabilityBadge", () => {
  it("已核验：显示等级 + 可执行性分数 + 一句话结论", () => {
    render(<ExecutabilityBadge plan={plan()} />);
    expect(screen.getByText(/A · 可执行性 100/)).toBeInTheDocument();
    expect(screen.getByText(/体检未发现阻断问题/)).toBeInTheDocument();
  });

  it("有硬问题时显示等级降级与问题条数", () => {
    render(
      <ExecutabilityBadge
        plan={plan({ warnings: ["第 1 天有 1 段「时间接不上」：x 到 y 只有 5 分钟"] })}
      />,
    );
    // 100-15=85 → B
    expect(screen.getByText(/B · 可执行性 85/)).toBeInTheDocument();
    expect(screen.getByText(/1 处会直接影响行程/)).toBeInTheDocument();
  });

  it("MOCK：明确写「未核验」，不显示分数", () => {
    render(<ExecutabilityBadge plan={plan({ verified: false, verification: "mock" })} />);
    expect(screen.getByText(/未核验/)).toBeInTheDocument();
    expect(screen.queryByText(/可执行性 \d+/)).not.toBeInTheDocument();
  });

  it("生成中：显示核验中", () => {
    render(<ExecutabilityBadge plan={plan({ draft: true })} />);
    expect(screen.getByText(/核验中/)).toBeInTheDocument();
  });
});
