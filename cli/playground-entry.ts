// ============================================================
// 离线验真台（public/verify-playground.html）的浏览器 bundle 入口
//
// 与 CLI / API / MCP 共用同一套 lib/verify 引擎与凭据实现——不另开一层判定，
// 否则「同一份文档在浏览器里算出同一个凭据 ID」这句话就是假的。
// 这里只做三件薄事：解析输入、调用引擎、挂上凭据。
// ============================================================

import { credentialOf } from "../lib/verify/credential";
import { verifyDocument } from "../lib/verify/engine";
import { repairDocument } from "../lib/verify/repair";
import { TRIP_CHECK_SAMPLES } from "../lib/verify/samples";
import {
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
  type TripCheckDocument,
} from "../lib/verify/types";
import { parseTripCheckDocument } from "../lib/verify/validate";

export const samples = TRIP_CHECK_SAMPLES.map((s) => ({
  id: s.id,
  label: s.label,
  description: s.description,
  document: s.document,
}));

export const versions = {
  engine: TRIP_CHECK_ENGINE_VERSION,
  ruleset: TRIP_CHECK_RULESET_VERSION,
  spec: TRIP_CHECK_SPEC_VERSION,
};

/** 返回给页面的统一形状：ok=false 时带可定位的字段错误 */
export function verify(raw: unknown) {
  const parsed = parseTripCheckDocument(raw);
  if (!parsed.ok) return { ok: false as const, errors: parsed.errors };
  const document: TripCheckDocument = parsed.value;
  const report = verifyDocument(document);
  report.credential = credentialOf(document);
  return { ok: true as const, report };
}

export function repair(raw: unknown) {
  const parsed = parseTripCheckDocument(raw);
  if (!parsed.ok) return { ok: false as const, errors: parsed.errors };
  const document: TripCheckDocument = parsed.value;
  const result = repairDocument(document);
  // 与 /api/verify/repair、CLI --fix 同口径：前后两张凭据，改了什么可对账
  result.before.credential = credentialOf(document);
  result.after.credential = credentialOf(result.document);
  return { ok: true as const, repair: result };
}
