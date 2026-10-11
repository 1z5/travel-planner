import "@testing-library/jest-dom/vitest";

// jsdom 不实现的浏览器 API 打桩
if (!globalThis.navigator.clipboard) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async () => {} },
    configurable: true,
  });
}
