import "server-only";
import type { Plan } from "../types";
import { planToDocument } from "./adapt";
import { credentialOf } from "./credential";
import { verifyDocument } from "./engine";
import { jsonLdScript, planToTouristTripJsonLd } from "./jsonld";
import type { TripCheckCredential, TripCheckReport } from "./types";

// ============================================================
// 把「一份内部 Plan」一次性打成对外工件：开放文档 → 两轴报告 → 可复算凭据 + JSON-LD。
//
// 为什么抽成一层（而不是在分享页里拼三步）：
// 1) 分享页是 RSC，直接在 render 体里调 new Date()/Hash 会被 react(purity) 规则判为
//    渲染期调用不纯函数；抽到 server-only 的领域函数里，调用点就只是「取一份工件」。
// 2) 未来工作台/API/Poster 也要同一套工件：只有一份实现，凭据口径才不会漂移。
// 3) 时间只影响展示字段（checkedAt/issuedAt），不参与判定与凭据 ID（见 credential.ts），
//    所以每次请求重新签发不会让同一份行程的 ID 变化。
// ============================================================

export interface PlanStamp {
  document: ReturnType<typeof planToDocument>;
  report: TripCheckReport;
  credential: TripCheckCredential;
  jsonLd: Record<string, unknown>;
  /** 已转义 </script> 的 JSON-LD 字符串，可直接塞进 <script>（见 jsonld.ts） */
  jsonLdInline: string;
}

/**
 * 生成一份行程的体检工件。
 *
 * @param plan 已持久化的 Plan（来自 resolvePlan）
 * @param options.id  对外标识（分享 token）
 * @param options.url 分享页绝对地址（JSON-LD 的 url 字段；没有就不写）
 */
export function stampPlan(plan: Plan, options: { id?: string; url?: string } = {}): PlanStamp {
  const document = planToDocument(plan, options.id ? { id: options.id } : {});
  const now = new Date();
  const report = verifyDocument(document, {}, now);
  const credential = credentialOf(document, {}, now);
  const jsonLd = planToTouristTripJsonLd(plan, options.url ? { url: options.url } : {});
  return { document, report, credential, jsonLd, jsonLdInline: jsonLdScript(jsonLd) };
}
