// 「行程管家」对话助手的共享类型（client-safe：客户端组件与服务端都要用）。
//
// 为什么单独成文件：服务端实现（lib/copilot.ts）会 import "server-only"，
// 客户端组件不能 import 它；但两边必须用同一份 suggestion 结构，否则
// 「服务端给的建议前端渲染不出来」这类漂移只能靠联调发现。类型放这里，两边共用。

export interface CopilotMsg {
  role: "user" | "assistant";
  content: string;
}

/** 可执行建议：要么是一次「一键修复」（体检查出的问题），要么是「一键顺延时间轴」 */
export type CopilotSuggestion =
  | {
      kind: "fix";
      fixKind: "transit" | "pace" | "budget-over" | "budget-under" | "rain" | "hours";
      day: number;
      label: string;
    }
  | { kind: "retime"; day: number; label: string };

export interface CopilotAnswer {
  answer: string;
  suggestion?: CopilotSuggestion;
  usage?: number;
}
