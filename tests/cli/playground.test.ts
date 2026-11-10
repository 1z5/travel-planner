// 离线验真台产物的契约测试。
//
// 最重要的断言不是「文件存在」，而是：浏览器 bundle 必须与 CLI/服务端算出
// 同一个凭据 ID。否则「同一套引擎、任何人可复算」就是一句空话。
// 做法是直接从生成的 HTML 里抽出内联脚本，在测试环境里真的执行它。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TextEncoder as NodeTextEncoder } from "node:util";
import { describe, expect, it } from "vitest";

// 不用 import.meta.url：vitest 的 jsdom 环境会把它转成非 file: scheme，fileURLToPath 直接抛错
const htmlPath = resolve(process.cwd(), "public/verify-playground.html");
const html = readFileSync(htmlPath, "utf8");

function loadBundle() {
  // vitest 的 jsdom 环境历史上不提供 TextEncoder；浏览器和 Node 都有，测试里补上即可
  if (!globalThis.TextEncoder) {
    (globalThis as { TextEncoder?: typeof NodeTextEncoder }).TextEncoder = NodeTextEncoder;
  }
  const start = html.indexOf("<script>");
  const end = html.indexOf("</script>", start);
  const code = html.slice(start + "<script>".length, end);
  // eslint-disable-next-line no-new-func -- 这里就是要在受控作用域里执行产物 bundle
  return new Function(`${code}\nreturn TripCheck;`)() as {
    verify: (raw: unknown) => {
      ok: boolean;
      report?: { credential?: { id: string }; verdict: { overall: string } };
      errors?: unknown[];
    };
    repair: (raw: unknown) => {
      ok: boolean;
      repair?: {
        before: { credential?: { id: string } };
        after: { credential?: { id: string } };
        applied: unknown[];
      };
      errors?: unknown[];
    };
    samples: Array<{ id: string; document: unknown }>;
    versions: { engine: string; ruleset: string; spec: string };
  };
}

describe("public/verify-playground.html · 自包含产物", () => {
  it("物理上关掉网络：CSP connect-src none、无外链脚本、无占位符残留", () => {
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toContain("__TRIP_CHECK_BUNDLE__");
    expect(html.length).toBeGreaterThan(100_000); // bundle 真的内联了，不是空壳
  });

  it("内联 bundle 可执行：导出 verify / repair / samples / versions", () => {
    const tc = loadBundle();
    expect(typeof tc.verify).toBe("function");
    expect(typeof tc.repair).toBe("function");
    expect(tc.samples.map((s) => s.id)).toEqual(["verified", "blocked", "unverified"]);
    expect(tc.versions.spec).toBe("trip-check/0.1");
  });

  it("浏览器与 CLI 算出同一个凭据 ID（blocked 示例）", () => {
    const tc = loadBundle();
    const blocked = tc.samples.find((s) => s.id === "blocked")!.document;
    const out = tc.verify(blocked);
    expect(out.ok).toBe(true);
    expect(out.report?.credential?.id).toBe("tc_46031b8729399c8d94e0f7cd48f2629c");
    expect(out.report?.verdict.overall).toBe("blocking");
  });

  it("--fix 等价：浏览器修复给出同一组前后凭据", () => {
    const tc = loadBundle();
    const blocked = tc.samples.find((s) => s.id === "blocked")!.document;
    const out = tc.repair(blocked);
    expect(out.ok).toBe(true);
    expect(out.repair?.before.credential?.id).toBe("tc_46031b8729399c8d94e0f7cd48f2629c");
    expect(out.repair?.after.credential?.id).toBe("tc_ffb2639c1cec6ab600339cb1313b5821");
    expect(out.repair?.applied.length).toBeGreaterThan(0);
  });

  it("非法文档返回字段级错误，不假装判过", () => {
    const tc = loadBundle();
    const out = tc.verify({ specVersion: "wrong" });
    expect(out.ok).toBe(false);
    expect(out.errors?.length).toBeGreaterThan(0);
  });
});
