import Link from "next/link";
import { Lock } from "lucide-react";
import type { Plan } from "@/lib/types";

// ============================================================
// 演示行程「只读」提示（client/server 通用，无状态）
//
// 背景：DEMO_SEED 注入的示例行程带 plan.demo=true——写端点（refine/restore/
// repair/adjust/candidates）会 403 拒绝，避免公开演示工件被任意访客改坏。
// 但「点了才报错」体验很差：用户以为按钮坏了。所以写操作入口要在动手前
// 说清楚，并保留唯一允许的动作：克隆（生成一份全新的、可编辑的行程）。
//
// 组件自己做 plan.demo 判断：非示例行程返回 null，调用方可以无条件挂载。
// 挂载建议（分享页在 Lead 的 scope）：
//   <DemoReadOnlyNote plan={plan} variant="share" />
// 放在凭据卡之前或页面元信息（page-meta）之后；示例行程的克隆入口本来就在
// 同一页的 CloneCTA。
// ============================================================

export function DemoReadOnlyNote({
  plan,
  shareId,
  variant = "workspace",
  className,
}: {
  plan: Pick<Plan, "demo">;
  /** workspace 变体给「去分享页克隆」链接用；share 变体不需要（克隆入口就在本页） */
  shareId?: string;
  variant?: "workspace" | "share";
  className?: string;
}) {
  // 非示例行程：整块不渲染（不改变现有页面）
  if (plan.demo !== true) return null;

  return (
    <div
      className={`tc-demo-note tc-demo-note-${variant}${className ? ` ${className}` : ""}`}
      role="note"
      aria-label="示例行程只读提示"
    >
      <Lock size={14} aria-hidden="true" />
      <p>
        <b>示例行程 · 只读</b>
        <span className="tc-demo-note-text">
          ：来自公开演示，写操作（调整顺序 / 重排时间 /
          确定性修复）已关闭；克隆成你的行程后即可编辑。
        </span>{" "}
        {variant === "share" ? (
          <span className="tc-demo-note-text">
            本页「克隆成我的行程」生成的是一份全新的、可编辑的行程。
          </span>
        ) : shareId ? (
          <Link href={`/p/${shareId}`} className="btn-link tc-demo-note-link">
            去分享页克隆 →
          </Link>
        ) : null}
      </p>
    </div>
  );
}
