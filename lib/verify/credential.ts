import "server-only";
import { createHash } from "node:crypto";
import {
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckCredential,
  type TripCheckDocument,
  type TripCheckOptions,
} from "./types";

// ============================================================
// 体检凭据（可复算，不是「数字签名」）
//
// 为什么需要：R1 调研的结论是「平台不背责任 → 供给方需要可证明没错的能力」。
// 一个分数截图证明不了任何事；可对账的凭据至少要满足：
//   同一份文档 + 同一口径 + 同一引擎/规则版本 → 任何一方重跑都得到同一个 ID。
//
// 为什么不是签名：本产品没有面向第三方的密钥托管，冒然做「签名」只会制造
// 假信任（签名只能证明「我们签发过」，不能证明判定是对的）。确定性哈希的
// 语义更诚实：**它只保证可复现、可对账**，判定质量靠公开规则与测试。
//
// ID 口径（写死在 docs/TRIP-CHECK-STANDARD.md，任何人都能复算）：
//   inputHash = sha256(canonicalJson({ document, options }))
//   id        = "tc_" + sha256(`${specVersion}|${engineVersion}|${rulesetVersion}|${inputHash}`).slice(0, 32)
//
// canonicalJson：对象键排序、忽略 undefined、数组保序 —— 保证跨语言/跨实现
// 的 JSON 规范化一致（第三方可以用任意语言复算）。
// ============================================================

/** 规范化 JSON：对象键排序、省略 undefined、数组保序（undefined 元素按 JSON 语义变 null） */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean" || t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isFinite(value as number) ? JSON.stringify(value) : "null";
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return "null";
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 输入哈希：document + options 的规范 JSON 的 sha256 */
export function inputHashOf(document: TripCheckDocument, options: TripCheckOptions = {}): string {
  return sha256Hex(canonicalJson({ document, options }));
}

/**
 * 生成体检凭据。
 *
 * @param document 已通过校验/规范化的开放文档
 * @param options  判定口径（必须与 verifyDocument 的入参一致，否则凭据对不上）
 * @param now      签发时间（只用于展示；ID 不含时间，保证同一输入可复算）
 */
export function credentialOf(
  document: TripCheckDocument,
  options: TripCheckOptions = {},
  now: Date = new Date(),
): TripCheckCredential {
  const inputHash = inputHashOf(document, options);
  const id = `tc_${sha256Hex(
    `${TRIP_CHECK_SPEC_VERSION}|${TRIP_CHECK_ENGINE_VERSION}|${TRIP_CHECK_RULESET_VERSION}|${inputHash}`,
  ).slice(0, 32)}`;
  return {
    id,
    algorithm: "sha256",
    inputHash,
    specVersion: TRIP_CHECK_SPEC_VERSION,
    engineVersion: TRIP_CHECK_ENGINE_VERSION,
    rulesetVersion: TRIP_CHECK_RULESET_VERSION,
    issuedAt: now.toISOString(),
    basis:
      "sha256(specVersion|engineVersion|rulesetVersion|sha256(canonical-json({document,options})))",
  };
}
