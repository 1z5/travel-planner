import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BackToTop } from "@/components/BackToTop";

// 回到顶部浮钮：滚过 600px 才出现、点击回顶、回到 <600px 再隐藏。

function setScrollY(y: number) {
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  fireEvent.scroll(window);
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
});

describe("BackToTop", () => {
  it("初始（未滚动）不渲染", () => {
    Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    render(<BackToTop />);
    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
  });

  it("滚过 600px 才出现；点击滚回顶部；回到顶部后隐藏", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    render(<BackToTop />);

    // 599px：仍不出现（阈值内）
    setScrollY(599);
    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();

    setScrollY(601);
    const button = screen.getByRole("button", { name: "回到顶部" });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ top: 0 });

    // 滚动回顶部后浮钮消失
    setScrollY(0);
    expect(screen.queryByRole("button", { name: "回到顶部" })).not.toBeInTheDocument();
  });

  it("prefers-reduced-motion：瞬时回顶（behavior=auto）", () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    render(<BackToTop />);
    setScrollY(900);
    fireEvent.click(screen.getByRole("button", { name: "回到顶部" }));
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ top: 0, behavior: "auto" });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
  });
});
