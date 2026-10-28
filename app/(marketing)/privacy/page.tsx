import type { Metadata } from "next";
import Link from "next/link";

// 隐私政策：ToC 产品面向不特定公众，且登录会收集手机号——没有这份文件
// 既不合规也让用户不敢用。内容只写**实际发生的事**，不写漂亮话。
export const metadata: Metadata = {
  title: "隐私政策 — 行程规划师",
  description: "我们收集什么、用来做什么、保留多久、你的权利，以及如何删除。",
};

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <div className="container legal-inner">
        <p className="legal-eyebrow">PRIVACY · 隐私政策</p>
        <h1>隐私政策</h1>
        <p className="legal-updated">最后更新：2026-10-24（条款变更时会更新此日期）</p>

        <h2>1. 我们收集什么</h2>
        <ul>
          <li>
            <strong>手机号</strong>：仅当你使用短信/微信登录时获取，用于登录态与按用户配额。
            开发模式（验证码固定）不会发送真实短信。
          </li>
          <li>
            <strong>你填写的行程条件</strong>：目的地、起止时间、预算、节奏、偏好、住所、
            期望必游地、重点活动。这些是生成行程的输入。
          </li>
          <li>
            <strong>生成的行程内容</strong>：结构化行程（含 POI 名称、营业时间、通勤、花费），
            以及你后续的修改记录（ revision ）。
          </li>
          <li>
            <strong>访问与配额数据</strong>：IP、时间、请求路径，用于限流、防滥用与故障排查。
          </li>
          <li>
            <strong>本机索引</strong>：「最近行程」保存在你的浏览器 localStorage 中，仅存在本机，
            不上传；清除浏览器数据即消失。
          </li>
        </ul>

        <h2>2. 用来做什么</h2>
        <p>
          生成与修改行程、按配额防止滥用、保障服务安全、排查故障。
          <strong>不用来做画像售卖， 不接广告 SDK，不向第三方出售你的数据。</strong>
        </p>

        <h2>3. 会分享给谁</h2>
        <ul>
          <li>
            <strong>高德开放平台</strong>：POI 检索、营业时间、路况与静态地图。产品内展示的数据
            均来自高德，并已标注来源。
          </li>
          <li>
            <strong>大模型服务商</strong>（由部署方配置）：行程由模型排布。我们只把
            <em>行程条件与已核验的事实清单</em>发给模型，<strong>不发送你的手机号</strong>。
            若部署方把模型接口配置到境外服务，你的行程条件可能随请求出境——这一点取决于部署配置。
          </li>
        </ul>

        <h2>4. 保留多久</h2>
        <table className="legal-table">
          <thead>
            <tr>
              <th>数据</th>
              <th>保留</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>短信验证码</td>
              <td>5 分钟有效、一次性消费，用后即删</td>
            </tr>
            <tr>
              <td>生成任务记录</td>
              <td>2 小时（一次性执行记录）</td>
            </tr>
            <tr>
              <td>行程（含分享链接）</td>
              <td>直到你删除，或你主动销毁分享链接</td>
            </tr>
            <tr>
              <td>访问/配额日志</td>
              <td>按运维需要短期保留，不用于识别个人</td>
            </tr>
          </tbody>
        </table>

        <h2>5. 你的权利</h2>
        <p>
          你可以要求<strong>查看、更正、删除</strong>你的数据。删除后你的行程与分享链接会失效，
          已生成的行程文件（如你自己导出的日历/PDF）不在我们控制范围内。
        </p>

        <h2>6. Cookie</h2>
        <p>
          仅使用维持登录态所必需的会话 Cookie（<code>tp_session</code>）。不使用第三方跟踪
          Cookie，当前未接入任何分析或广告 SDK。
        </p>

        <h2>7. 未成年人</h2>
        <p>本服务面向成年用户。我们不主动收集未成年人的个人信息。</p>

        <h2>8. 联系我们</h2>
        {/* 占位邮箱用 RFC 2606 保留域名 .example（不可达），上线前必须换成真实可收信邮箱：
            对外法律文本里放一个看起来像真的假邮箱，比明确标注「待替换」更糟。 */}
        <p>
          数据相关问题请通过仓库 Issues
          联系我们；正式上线前会公布专用隐私邮箱。请勿在公开渠道粘贴个人信息。
          我们会在合理期限内答复。
        </p>

        <div className="legal-actions">
          <Link href="/terms" className="btn btn-ghost btn-sm">
            阅读用户协议
          </Link>
          <Link href="/" className="btn btn-ghost btn-sm">
            回到我的行程
          </Link>
        </div>
      </div>
    </main>
  );
}
