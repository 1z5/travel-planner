import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "隐私政策 — AI Travel Companion",
  description: "行程、定位、分享链接和登录数据的处理方式。",
};

export default function PrivacyPage() {
  return (
    <main className="legal-page">
      <div className="container legal-inner">
        <h1>隐私政策</h1>
        <p className="legal-updated">更新于 2026-11-18</p>
        <p>
          本页说明 AI Travel Companion
          的数据处理。自托管实例的服务商、日志和备份设置由实际部署方管理。
        </p>

        <h2>行程、登录与使用记录</h2>
        <ul>
          <li>
            生成行程时，服务端保存你提交的条件和行程结果。住宿、活动和偏好等选填项也会随行程请求发送。
          </li>
          <li>
            短信登录处理手机号，微信登录处理微信账号标识，用于验证身份和管理配额。会话 Cookie
            有效期为 7 天，短信验证码有效期为 5 分钟。
          </li>
          <li>
            登录的行程主人可记录到达或跳过。服务端保存站点、操作和时间，分享页不会展示这份记录。
          </li>
          <li>
            服务端用 IP
            或登录标识执行限流。产品使用统计可能记录操作类型、行程链接标识、目的地和行程天数。最近行程、想去清单、导入的行程文件和主题设置保存在当前浏览器。
          </li>
        </ul>

        <h2>定位与外部服务</h2>
        <ul>
          <li>
            打开未指定城市的新建页，或点击「用我当前的位置」时，浏览器可以请求定位权限。授权后，服务器接收坐标，并在地图服务启用时向高德查询城市。
          </li>
          <li>
            行中页的「离我多远」在浏览器中计算直线距离。你可以在浏览器设置里关闭定位，继续手动输入城市。
          </li>
          <li>
            高德提供地点、地图、路线和天气资料。生成、修改、问答和文本提取会把完成请求所需的信息发给部署方选用的模型服务。模型服务的处理地点和留存规则视部署配置而定。
          </li>
        </ul>

        <h2 id="sharing">分享链接</h2>
        <p>
          持有普通行程分享链接的人可以打开行程，在支持编辑的行程里也可修改安排。请只向你信任的人发送链接，并避免在行程里写入不适合分享的信息。
        </p>

        <h2>保留、访问和删除</h2>
        <p>
          生成任务通常在两小时后进入过期清理。PostgreSQL
          中的行程没有自动过期时间。移除首页的行程只清除本机入口，清除浏览器站点数据也会清除本地行程文件副本、索引和缓存。
        </p>
        <p>
          目前页面没有删除服务器行程或撤销分享链接的入口。查看、更正或删除服务端个人数据，请联系当前实例的管理方。
          项目演示站可在<a href="https://github.com/1z5/AI-Travel-Companion/issues">仓库 Issues</a>
          留言请求私下联系方式。公开留言请勿附上分享链接、坐标或个人信息。
        </p>

        <div className="legal-actions">
          <Link href="/terms" className="btn btn-ghost btn-sm">
            使用条款
          </Link>
          <Link href="/" className="btn btn-ghost btn-sm">
            我的行程
          </Link>
        </div>
      </div>
    </main>
  );
}
