import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeToggle } from "@/components/ThemeToggle";

// 主题开关是产品壳唯一的全局设置入口。视觉回归只模拟系统暗色，
// 这里补上「手动切换 → localStorage / data-theme / theme-color 同步」的契约。
describe("ThemeToggle", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.head.innerHTML = '<meta name="theme-color" content="#f4f6f4" />';
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
    );
  });

  afterEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    document.head.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("按 auto → light → dark → auto 循环，并同步主题色", async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /切换主题/ });

    await user.click(button);
    expect(window.localStorage.getItem("at-theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#f4f6f4",
    );

    await user.click(button);
    expect(window.localStorage.getItem("at-theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#101816",
    );

    await user.click(button);
    expect(window.localStorage.getItem("at-theme")).toBeNull();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#f4f6f4",
    );
  });
});
