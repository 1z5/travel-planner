import { ImageResponse } from "next/og";
import { resolvePlan } from "@/lib/plan-repo";
import { checkProxyRateLimit } from "@/lib/proxy-rate-limit";
import { stampPlan } from "@/lib/verify/stamp";
import { buildCheckPosterModel } from "@/lib/trip-check-report";

// 竖版体检海报：1080×1920，供「保存海报 → 微信发朋友」。
//
// 与 /p/<id>/poster（行程海报）是一对：那张讲「去哪玩」，这张讲「行程能不能照着走」。
// 数据全部来自 buildCheckPosterModel（与报告页/纯文本同源，见 lib/trip-check-report.ts），
// 所以海报不会比页面多说一句。
//
// Satori 硬约束（与 app/p/[id]/poster/route.tsx 同一套教训，改这里前先读那边注释）：
// 1. 多子节点的 div 必须显式 display:flex（数字/表达式都算 children）；
// 2. 不支持 -webkit-line-clamp，长文本 JS 截断（模型里 detail 已截断，这里再兜底）；
// 3. 中文回退系统 CJK 字体，不在仓库里搬字体文件。
//
// 诚实红线：事实未核验/部分核验必须原样印在海报上，绝不写成「已核验」——
// 海报是传播物，假结论传得最远。

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const size = { width: 1080, height: 1920 };
export const contentType = "image/png";

const INK = "#221d16";
const PAPER = "#f6f0e4";
const ACCENT = "#c2410c";
const MUTED = "#6b5f52";
const FAINT = "#8a7d6c";

const clamp = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const rl = await checkProxyRateLimit(req.headers, "poster", "POSTER_HOURLY_LIMIT", 120);
  if (!rl.allowed) {
    return new Response("海报生成过于频繁，请稍后再试", {
      status: 429,
      headers: { "Retry-After": "600", "Cache-Control": "no-store" },
    });
  }
  const { id } = await params;
  // 与分享页/报告页同口径：新 token 读持久化 Plan，旧 jobId 链接兜底
  const plan = await resolvePlan(id);
  // 行程不存在 → 404：传播物上不渲染假数据
  if (!plan) {
    return new Response("行程不存在", { status: 404 });
  }

  const stamp = stampPlan(plan, { id });
  const model = buildCheckPosterModel(stamp.report, {
    maxIssues: 4,
    credentialId: stamp.credential.id,
  });
  // 「已核验」只在事实轴确实为 verified 时出现；其余状态如实标注
  const verified = model.factsLabel === "已核验";
  const factsLine = verified
    ? "事实核验：已核验"
    : `事实核验：${model.factsLabel}（未核验 ≠ 没问题）`;
  const credentialShort =
    model.credentialId.length > 22 ? `${model.credentialId.slice(0, 22)}…` : model.credentialId;

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: PAPER,
        padding: "84px 76px",
        fontFamily: "serif",
        color: INK,
        borderTop: `14px solid ${ACCENT}`,
      }}
    >
      {/* 顶部：品牌 + 这是什么 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", width: 14, height: 14, background: ACCENT }} />
          <div style={{ display: "flex", fontSize: 30, letterSpacing: 2 }}>行程规划师</div>
        </div>
        <div style={{ display: "flex", fontSize: 28, color: MUTED }}>
          行程体检报告 · Trip Check {stamp.report.specVersion}
        </div>
      </div>

      {/* 中部：城市/天数 + 结论 + 等级/事实 + 问题 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 38 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 22 }}>
            <div style={{ display: "flex", fontSize: 96, lineHeight: 1.1 }}>{model.city}</div>
            <div style={{ display: "flex", fontSize: 40, color: MUTED }}>{model.daysText}</div>
          </div>
          <div style={{ display: "flex", fontSize: 34, lineHeight: 1.45 }}>
            {clamp(model.headline, 58)}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              width: 210,
              height: 210,
              border: `3px solid ${INK}`,
              background: "#fffdf7",
            }}
          >
            <div style={{ display: "flex", fontSize: 120, lineHeight: 1 }}>{model.grade}</div>
            <div style={{ display: "flex", fontSize: 24, color: MUTED }}>{model.gradeLabel}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, flex: 1 }}>
            <div style={{ display: "flex", fontSize: 42, lineHeight: 1.3 }}>
              结构自洽性 {model.grade} · {model.score}/100
            </div>
            <div style={{ display: "flex", fontSize: 30, color: verified ? MUTED : ACCENT }}>
              {factsLine}
            </div>
            <div style={{ display: "flex", fontSize: 24, lineHeight: 1.5, color: MUTED }}>
              {clamp(model.factsSummary, 72)}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 18,
            borderTop: `2px solid ${INK}`,
            paddingTop: 26,
          }}
        >
          <div style={{ display: "flex", fontSize: 28, letterSpacing: 1 }}>需要处理的问题</div>
          {model.issues.map((issue) => (
            <div
              key={`${issue.ruleId}-${issue.title}`}
              style={{ display: "flex", flexDirection: "column", gap: 6 }}
            >
              <div style={{ display: "flex", fontSize: 26, color: ACCENT }}>
                {issue.ruleId} · {issue.title}
              </div>
              <div style={{ display: "flex", fontSize: 26, lineHeight: 1.45 }}>
                {clamp(issue.detail, 50)}
              </div>
            </div>
          ))}
          {model.issueOverflow > 0 && (
            <div style={{ display: "flex", fontSize: 24, color: MUTED }}>
              还有 {model.issueOverflow} 条问题 · 完整报告见分享链接
            </div>
          )}
          {model.issues.length === 0 && (
            <div style={{ display: "flex", fontSize: 26, color: MUTED }}>
              按当前规则与文档数据，未发现阻断或需微调的问题。
            </div>
          )}
        </div>
      </div>

      {/* 底部：凭据 + 边界 + 品牌 */}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", fontSize: 26 }}>凭据 {credentialShort}</div>
        <div style={{ display: "flex", fontSize: 24, color: MUTED }}>
          可复算 · 不是数字签名 · 判定基于文档声明的事实来源
        </div>
        <div style={{ display: "flex", fontSize: 22, color: FAINT }}>{model.engineLine}</div>
        <div style={{ display: "flex", fontSize: 24, color: MUTED }}>{model.brandLine}</div>
      </div>
    </div>,
    {
      ...size,
      headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
    },
  );
}
