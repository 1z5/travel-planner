import Link from "next/link";

// ============================================================
// 营销站顶栏（只在 /about 使用，服务端组件，零客户端 JS）。
//
// 产品面与营销面已拆分：产品页用 AppShell（我的行程 / 新建），
// 这里的导航只服务「了解产品」的访客，不再挂在分享页/行中页上。
// ============================================================

/** 品牌标记：方形纸片上的「行」字——像一枚印章，克制、可复用在 favicon/OG */
export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      行
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="brand" aria-label="行程规划师 我的行程">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">行程规划师</span>
            <span className="brand-sub">TRAVEL PLANNER</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label="主导航">
          <Link href="/about#how">怎么工作</Link>
          <Link href="/about#cap">产品能力</Link>
          <Link href="/about#trust">数据可信</Link>
          <Link href="/about#faq">常见问题</Link>
        </nav>

        <div className="site-header-actions">
          <Link href="/" className="btn btn-ghost btn-sm">
            我的行程
          </Link>
          <Link href="/new" className="btn btn-primary btn-sm">
            新建行程
          </Link>
        </div>
      </div>
    </header>
  );
}
