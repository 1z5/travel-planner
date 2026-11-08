import { canonicalJson } from "./canonical";
import { sha256Hex } from "./sha256";
import { sliceSource, HANDOFF_MAX_CLAIMS } from "./slice";
import {
  HANDOFF_FORMAT_VERSION,
  HANDOFF_NOTICE,
  type ClaimStatus,
  type HandoffAction,
  type HandoffClaim,
  type HandoffReceipt,
} from "./types";

// 交接单的构造与离线复算。
//
// 与 lib/verify/credential.ts 的关键差别（也是产品语义的差别）：
// credentialOf 对「状态快照」哈希、ID 故意不含时间，为的是同一输入必得同一 ID；
// 交接单的价值恰恰在「当时」——出发前签的和回来后补的必须可区分，所以
// createdAt 与每一条 append-only 动作都进事件链，ID 取链尾。

function skeleton(claims: HandoffClaim[]) {
  return claims.map((c) => ({ id: c.id, text: c.text, span: c.span }));
}

/** 从 source + actions 重算链、decision 与 id。纯函数，浏览器/Node 结果一致。 */
export function finalizeReceipt(r: HandoffReceipt): HandoffReceipt {
  const genesis = sha256Hex(
    canonicalJson({
      v: r.v,
      source: r.source,
      createdAt: r.createdAt,
      truncated: r.truncated,
      claims: skeleton(r.claims),
    }),
  );
  const chain: string[] = [genesis];
  for (const action of r.actions) {
    chain.push(sha256Hex(`${chain[chain.length - 1]}|${canonicalJson(action)}`));
  }
  // append-only：最后一条 decision 即当前决定。用正序扫描而不是 reverse，
  // 既避免原地修改，也不依赖 toReversed 的运行时版本。
  let lastDecision: HandoffAction | undefined;
  for (const action of r.actions) {
    if (action.type === "decision") lastDecision = action;
  }
  const tail = chain[chain.length - 1] as string;
  return { ...r, decision: lastDecision?.decision ?? "", chain, id: `hr_${tail.slice(0, 32)}` };
}

/** 新建一张交接单：默认所有断言 unchecked，没有任何动作。 */
export function createReceipt(text: string, now: Date = new Date()): HandoffReceipt {
  const { claims, truncated } = sliceSource(text);
  const base: HandoffReceipt = {
    v: HANDOFF_FORMAT_VERSION,
    source: { kind: "paste", chars: text.length, sha256: sha256Hex(text), text },
    claims,
    actions: [],
    decision: "",
    createdAt: now.toISOString(),
    chain: [],
    id: "",
    notice: HANDOFF_NOTICE,
    truncated,
  };
  return finalizeReceipt(base);
}

/** 用户对某条断言表态。只追加动作，不改写历史。 */
export function applyMark(
  r: HandoffReceipt,
  claimId: string,
  to: ClaimStatus,
  opts: { basis?: string; note?: string; at?: string } = {},
): HandoffReceipt {
  const target = r.claims.find((c) => c.id === claimId);
  if (!target) return r;
  const action: HandoffAction = {
    at: opts.at ?? new Date().toISOString(),
    type: "mark",
    claimId,
    from: target.status,
    to,
    ...(opts.basis ? { basis: opts.basis } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  const claims = r.claims.map((c) =>
    c.id === claimId
      ? {
          ...c,
          status: to,
          ...(opts.basis !== undefined ? { basis: opts.basis } : {}),
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        }
      : c,
  );
  return finalizeReceipt({ ...r, claims, actions: [...r.actions, action] });
}

/** 写下「我决定怎么做」。同样只追加。 */
export function applyDecision(
  r: HandoffReceipt,
  decision: string,
  at: string = new Date().toISOString(),
): HandoffReceipt {
  const action: HandoffAction = { at, type: "decision", decision };
  return finalizeReceipt({ ...r, actions: [...r.actions, action] });
}

export interface Verification {
  ok: boolean;
  reason?: string;
}

/**
 * 离线复核一张单子：不需要我们的服务器，任何第三方拿 JSON 文件都能跑。
 * 校验四件事：原文哈希、断言确实是原文片段、事件链与 ID、最终状态能由动作推导。
 */
export function verifyReceipt(r: HandoffReceipt): Verification {
  if (r.v !== HANDOFF_FORMAT_VERSION) return { ok: false, reason: "格式版本不一致" };
  if (!r.source || typeof r.source.text !== "string") {
    return { ok: false, reason: "缺少自包含的原文" };
  }
  if (sha256Hex(r.source.text) !== r.source.sha256) {
    return { ok: false, reason: "原文与哈希不符" };
  }
  for (const c of r.claims) {
    if (r.source.text.slice(c.span[0], c.span[1]) !== c.text) {
      return { ok: false, reason: `断言 ${c.id} 无法回溯到原文` };
    }
  }

  const rebuilt = sliceSource(r.source.text, HANDOFF_MAX_CLAIMS);
  if (rebuilt.truncated !== r.truncated || rebuilt.claims.length !== r.claims.length) {
    return { ok: false, reason: "断言切片与原文不一致" };
  }
  const derived = new Map<string, ClaimStatus>();
  for (const c of rebuilt.claims) derived.set(c.id, "unchecked");
  for (const a of r.actions) {
    if (a.type !== "mark" || !a.claimId || !a.to) continue;
    derived.set(a.claimId, a.to);
  }
  for (const c of r.claims) {
    if (derived.get(c.id) !== c.status) {
      return { ok: false, reason: `断言 ${c.id} 的状态无法由动作推导` };
    }
  }

  const expected = finalizeReceipt(r);
  if (JSON.stringify(expected.chain) !== JSON.stringify(r.chain)) {
    return { ok: false, reason: "事件链被改动" };
  }
  if (expected.id !== r.id) return { ok: false, reason: "单子编号与事件链不符" };
  return { ok: true };
}

export function countByStatus(r: HandoffReceipt): Record<ClaimStatus, number> {
  const out: Record<ClaimStatus, number> = { unchecked: 0, verified: 0, changed: 0, trusted: 0 };
  for (const c of r.claims) out[c.status] += 1;
  return out;
}
