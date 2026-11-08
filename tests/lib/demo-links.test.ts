import { describe, expect, it } from "vitest";
import { DEMO_FIXTURES } from "@/demo/fixtures";
import {
  DEMO_POLISHED_SHARE_ID,
  DEMO_SHOWCASE_SHARE_ID,
  demoShareHref,
} from "@/lib/demo/demo-links";

// 展示入口是产品里最不能悄悄坏掉的链接：按钮点开 404，比没有按钮更伤。
// demo:gen 会重新生成 fixture 并换掉 shareId，所以这里把常量与 fixture 钉在一起，
// 重跑脚本后若忘了同步 lib/demo-links.ts，单测直接报出来。
describe("展示入口的成品 token", () => {
  it("两个常量都必须对应当前仓库里的真实 fixture", () => {
    const ids = DEMO_FIXTURES.map((f) => f.shareId);
    expect(ids).toContain(DEMO_SHOWCASE_SHARE_ID);
    expect(ids).toContain(DEMO_POLISHED_SHARE_ID);
    expect(DEMO_SHOWCASE_SHARE_ID).not.toBe(DEMO_POLISHED_SHARE_ID);
  });

  it("展示样本是真实验真的成品，不是 MOCK 结构预览", () => {
    const showcase = DEMO_FIXTURES.find((f) => f.shareId === DEMO_SHOWCASE_SHARE_ID);
    expect(showcase?.plan.verified).toBe(true);
    expect(showcase?.plan.verification).toBe("ok");
    expect(showcase?.plan.days.length).toBeGreaterThan(0);
  });

  it("href 指向只读分享页，不经过生成管线", () => {
    expect(demoShareHref(DEMO_SHOWCASE_SHARE_ID)).toBe(`/p/${DEMO_SHOWCASE_SHARE_ID}`);
    expect(demoShareHref(DEMO_SHOWCASE_SHARE_ID)).not.toContain("sample");
  });
});
