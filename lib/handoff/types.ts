// 交接单（Handoff Receipt）数据模型。
//
// 与 lib/verify 的根本差别：verify 描述「世界」（POI 是否存在、营业时间查没查过），
// 这里描述「人」——谁、在什么时候、对哪一条断言、声称自己核过 / 改过 / 决定先信着。
// 所以状态是 epistemic status（认知状态），不是 verification（事实状态）。
//
// 全部字段必须能在浏览器里独立构造与复算：不引 server-only、不依赖任何 API、
// 不需要服务端存储。单子本身就是完整证据，服务端可以不存在。

export const HANDOFF_FORMAT_VERSION = "hr/0.1";

/** 默认全量 unchecked：不是「我们核过」，是「目前没人核过」。 */
export type ClaimStatus = "unchecked" | "verified" | "changed" | "trusted";

export interface HandoffClaim {
  id: string;
  /** 原文里的连续片段，绝不由模型生成或改写 */
  text: string;
  /** [start, end) 字符区间（JS UTF-16 code unit），text === source.text.slice(...span) */
  span: [number, number];
  status: ClaimStatus;
  /** 用户自填：核过 / 改了的依据。我们从不代查 */
  basis?: string;
  /** 用户自填：改成了什么，或为什么决定先信着 */
  note?: string;
}

export type HandoffActionType = "mark" | "decision";

export interface HandoffAction {
  /** 设备自述时间（ISO）。我们不证明这个时刻是真的，见 receipt.notice */
  at: string;
  type: HandoffActionType;
  claimId?: string;
  from?: ClaimStatus;
  to?: ClaimStatus;
  basis?: string;
  note?: string;
  decision?: string;
}

export interface HandoffReceipt {
  v: typeof HANDOFF_FORMAT_VERSION;
  source: {
    kind: "paste";
    chars: number;
    sha256: string;
    /** 原文必须自包含，否则「断言来自原文」无法离线复核 */
    text: string;
  };
  claims: HandoffClaim[];
  /** append-only：只追加，永不改写或删除 */
  actions: HandoffAction[];
  /** 派生字段：最后一条 decision 动作。finalize 时从 actions 重算覆盖 */
  decision: string;
  createdAt: string;
  /** chain[0] = hash(源事件)，其后每段 = hash(前一段 ‖ 该动作) */
  chain: string[];
  id: string;
  notice: string;
  /** 切片被上限截断时如实记录，不静默丢弃 */
  truncated: number;
}

/** 单子上必须原样出现的诚实声明。别把它藏进隐私政策。 */
export const HANDOFF_NOTICE =
  "这张单子记录的是你自己当时确认了什么，不是我们对行程的判定。我们不核验事实、不评分、不担保任何一条；单子里的时刻由你的设备自述，我们不证明它真实。需要第三方固化时请自行使用可信时间戳。";
