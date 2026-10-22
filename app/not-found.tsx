import Link from "next/link";

// 品牌化 404：路径错误/分享链接失效时的兜底页。
// 企业级产品的 404 不是「Not Found」白屏——它要告诉用户发生了什么、
// 下一步能去哪里，并保持与全站一致的纸面语言。
export default function NotFound() {
  return (
    <main className="container">
      <div className="fault-page">
        <div className="fault-eyebrow">404 · PAGE NOT FOUND</div>
        <h1 className="fault-title">这个页面不存在</h1>
        <p className="fault-desc">
          链接可能输错了，或者这份行程已经被创建者删除。
          如果你是在找某份分享行程，请让分享者重新发一次链接；行程本体是持久保存的，不会因为时间过期。
        </p>
        <div className="fault-actions">
          <Link href="/" className="btn btn-primary btn-sm">
            回首页规划行程
          </Link>
          <Link href="/#faq" className="btn btn-sm">
            查看常见问题
          </Link>
        </div>
      </div>
    </main>
  );
}
