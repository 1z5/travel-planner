import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "使用条款 — AI Travel Companion",
  description: "行程工具的用途、配额、分享与开源许可。",
};

export default function TermsPage() {
  return (
    <main className="legal-page">
      <div className="container legal-inner">
        <h1>使用条款</h1>
        <p className="legal-updated">更新于 2026-11-18</p>

        <h2>服务范围</h2>
        <p>
          本项目提供行程规划、检查、分享和行中参考。项目演示站当前免费，生成和修改受配额限制。请勿绕过配额或干扰服务运行。
        </p>

        <h2>使用行程建议</h2>
        <p>
          行程中的建议可能由模型生成，营业时间和路线也可能变化。出行前请向场所或交通运营方确认营业、预约、票价和班次。工具不提供预订服务。
        </p>

        <h2>内容和分享</h2>
        <p>
          请仅提交你有权使用的内容。分享别人的行程或包含他人资料的内容前，请取得相应授权。导出的内容仍适用其中地图、地点资料等第三方内容的许可。
          <Link href="/privacy#sharing">分享链接的访问权限</Link>请见隐私政策。
        </p>

        <h2>开源与自托管</h2>
        <p>
          仓库代码依
          <a href="https://github.com/1z5/AI-Travel-Companion/blob/main/LICENSE">
            Apache-2.0 许可证
          </a>
          发布。 自托管时使用的地图、模型和托管服务受各自条款约束。
        </p>

        <div className="legal-actions">
          <Link href="/privacy" className="btn btn-ghost btn-sm">
            隐私政策
          </Link>
          <Link href="/" className="btn btn-ghost btn-sm">
            我的行程
          </Link>
        </div>
      </div>
    </main>
  );
}
