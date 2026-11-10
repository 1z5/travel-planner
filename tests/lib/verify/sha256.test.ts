// 同构 SHA-256 的对拍测试。
//
// 这里的断言是开放标准的安全带：凭据 ID 已经写进 README、分享页、CLI 输出，
// 任何一次哈希实现变更只要改变了一个字节，就必须让这些断言先失败。

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { credentialOf } from "@/lib/verify/credential";
import { getSample } from "@/lib/verify/samples";
import { sha256HexUtf8 } from "@/lib/verify/sha256";

const nodeSha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("sha256HexUtf8 · 与 node:crypto 字节级一致", () => {
  it("标准向量", () => {
    expect(sha256HexUtf8("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexUtf8("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("中文 / emoji / 控制字符 / 补位边界（55/56/63/64/65 字节）", () => {
    const cases = [
      "汉字",
      "苏州博物馆 周一闭馆 09:00-12:00",
      "🙂",
      "\u0000\u00ff\u4e2d",
      JSON.stringify({ a: 1, b: [1, 2, "é"] }),
    ];
    for (const len of [55, 56, 57, 63, 64, 65, 119, 128, 1000]) {
      cases.push("x".repeat(len), "中".repeat(len));
    }
    for (const c of cases) expect(sha256HexUtf8(c)).toBe(nodeSha(c));
  });

  it("大输入（跨多个 64 字节块）", () => {
    const s = "行程核验规范 v0.1 · ".repeat(2000);
    expect(sha256HexUtf8(s)).toBe(nodeSha(s));
  });
});

describe("凭据 ID 回归 · 换哈希实现不得改变已公开的 ID", () => {
  it("三份内置示例的凭据 ID 与 inputHash 冻结", () => {
    expect(credentialOf(getSample("verified")!.document).id).toBe(
      "tc_bf64bc25282df47b9c9ce5e6a5274d74",
    );
    expect(credentialOf(getSample("blocked")!.document).id).toBe(
      "tc_46031b8729399c8d94e0f7cd48f2629c",
    );
    expect(credentialOf(getSample("verified")!.document).inputHash).toBe(
      "f2e0f3b8c85cfdb2cbe06a72361cc8f1e747445e33ce0fb443b602be9d20edc8",
    );
  });
});
