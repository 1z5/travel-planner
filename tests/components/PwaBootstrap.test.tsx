import { describe, expect, it, vi } from "vitest";

// 断网提示条：useOffline 需要 mock（jsdom 里恒为 false，且生产才注册 SW）。
vi.mock("next/offline", () => ({ useOffline: () => true }));
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PwaBootstrap } from "@/components/PwaBootstrap";

describe("PwaBootstrap", () => {
  it("离线时显示提示条（说明显示的是缓存内容，不是报错）", () => {
    render(<PwaBootstrap />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/最后一次加载的内容/)).toBeInTheDocument();
  });

  it("提示条可关闭（不阻断行中操作）", async () => {
    render(<PwaBootstrap />);
    await userEvent.click(screen.getByRole("button", { name: "关闭离线提示" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
