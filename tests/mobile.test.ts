import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { viewport } from "@/app/layout";

// 移动端适配的回归保护。
//
// 为什么值得单测：viewport 缺失是移动端最致命的问题——没有它，手机浏览器
// 按 980px 宽度渲染再整体缩放，globals.css 里所有的 @media (max-width: 640px)
// 都不生效，页面在手机上是个缩小版的桌面站。而这个问题在桌面浏览器上
// **完全看不出来**，只有真机才能发现，所以必须用测试守住。

describe("移动端 viewport 配置", () => {
  it("声明 device-width（否则手机按 980px 渲染后缩放）", () => {
    expect(viewport.width).toBe("device-width");
  });

  it("initialScale: 1（不预先放大）", () => {
    expect(viewport.initialScale).toBe(1);
  });

  it("viewportFit: cover（配合 CSS 的 safe-area-inset 适配刘海屏）", () => {
    expect(viewport.viewportFit).toBe("cover");
  });

  it("不锁定缩放（无障碍红线：不得剥夺用户 pinch-zoom 能力）", () => {
    // WCAG 1.4.4 要求页面可放大 200%。设 maximumScale:1 或
    // userScalable:false 会直接违背，且伤害视力障碍用户。
    expect(viewport.maximumScale).toBeUndefined();
    expect(viewport.userScalable).toBeUndefined();
  });
});

describe("移动端 CSS 关键规则", () => {
  const css = readFileSync("app/globals.css", "utf8");

  it("input 在移动端用 16px 字号（防 iOS 聚焦时自动放大页面）", () => {
    // iOS Safari 对 font-size < 16px 的输入框，聚焦瞬间会把整个页面放大，
    // 用户必须手动缩小才能继续——移动端最经典的坑之一。
    expect(css).toMatch(/input,\s*textarea,\s*select\s*\{\s*font-size:\s*16px/);
  });

  it("容器有安全区适配（刘海屏边缘内容不被切口切掉）", () => {
    expect(css).toContain("env(safe-area-inset-left)");
    expect(css).toContain("env(safe-area-inset-bottom)");
  });

  it("主操作触控目标 ≥44px（Apple HIG / Material 最小可点击区域）", () => {
    expect(css).toMatch(/\.btn\s*\{\s*min-height:\s*44px/);
    expect(css).toMatch(/\.btn-primary\s*\{\s*min-height:\s*48px/);
  });

  it("移动端断点里包含 16px 覆写（确认规则在 media query 内而非全局）", () => {
    // 桌面端保持 14px 的设计，16px 只在 max-width:640px 内生效——
    // 若误改成全局，桌面视觉会回归
    const mobileBlock = css.slice(css.indexOf("@media (max-width: 640px)"));
    expect(mobileBlock).toMatch(/input,\s*textarea,\s*select\s*\{\s*font-size:\s*16px/);
  });
});
