import type { Metadata } from "next";
import Link from "next/link";

// 用户协议：把「AI 生成的行程」的边界写清楚——这是 ToC 产品最容易被投诉
// 的地方（用户拿着过期营业时间白跑一趟）。宁可保守，不要含糊。
export const metadata: Metadata = {
  title: "用户协议 — 行程规划师",
  description: "服务范围、内容归属、免责边界与收费方式。",
};

export default function TermsPage() {
  return (
    <main className="legal-page">
      <div className="container legal-inner">
        <p className="legal-eyebrow">TERMS · 用户协议</p>
        <h1>用户协议</h1>
        <p className="legal-updated">最后更新：2026-10-24（条款变更时会更新此日期）</p>

        <h2>1. 服务是什么</h2>
        <p>
          我们把真实世界的事实（POI 是否存在、营业时间、闭馆日、两站之间的通勤）取出来，
          再由模型在这些已核验的事实上排成结构化行程，并提供体检、修改、分享与行中视图。
          <strong>它是规划辅助工具，不是旅行社，不代订任何服务。</strong>
        </p>

        <h2>2. 内容的准确性</h2>
        <p>
          行程中的 POI、营业时间、闭馆与通勤来自高德开放平台与模型排布，我们会标注核验状态，
          并对「时间接不上」「可能闭馆」等问题给出预警。但
          <strong>我们不保证 100% 准确或实时</strong>：
          节假日安排、临时闭馆、排队与票价请以官方公告为准。发现错误可通过产品内的反馈入口告知我们。
        </p>

        <h2>3. 账号与配额</h2>
        <p>
          未登录按 IP、登录按用户设定每日生成配额与每小时修改上限，用于防止滥用和控制成本。
          绕过配额（包括伪造请求头）可能导致功能被限制。
        </p>

        <h2>4. 内容与知识产权</h2>
        <ul>
          <li>你生成的行程内容归你所有，可自由分享、导出、打印。</li>
          <li>本产品的代码、设计、文档与商标归运营方所有，保留所有权利（见 LICENSE）。</li>
          <li>你不得将本服务用于转售、爬取批量数据或对第三方提供同类服务。</li>
          <li>通过分享链接打开他人行程时，请仅用于个人参考。</li>
        </ul>

        <h2>5. 免责</h2>
        <p>
          行程建议不构成任何承诺。出行安全、健康状况、消费决策由你自己判断并负责；
          因信息变更、自然灾害、公共卫生事件等造成的损失，我们在法律允许的范围内不承担责任。
        </p>

        <h2>6. 收费</h2>
        <p>
          当前免费额度内不收费。若将来推出付费功能，会提前在产品内明示价格与退款规则，
          不会在你未确认的情况扣费。
        </p>

        <h2>7. 终止与数据删除</h2>
        <p>
          你可以随时停止使用并要求删除数据（见<Link href="/privacy">隐私政策</Link>第 5
          节）。严重违反本协议（如滥用、攻击、转售）时，我们可能限制你的访问。
        </p>

        <h2>8. 适用法律</h2>
        <p>本协议适用中华人民共和国法律。争议优先通过协商解决。</p>

        <div className="legal-actions">
          <Link href="/privacy" className="btn btn-ghost btn-sm">
            阅读隐私政策
          </Link>
          <Link href="/" className="btn btn-ghost btn-sm">
            回到我的行程
          </Link>
        </div>
      </div>
    </main>
  );
}
