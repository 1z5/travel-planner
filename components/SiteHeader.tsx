import Link from "next/link";

// ============================================================
// 全站顶栏（服务端组件，零客户端 JS）。
//
// 为什么需要它：企业级产品的第一信号是「有稳定的应用外壳」——品牌、
// 导航、动作在每一页都在同一位置。此前的页面没有全局导航，看起来像
// 一个单页 demo。
//
// 导航链接只指向真实存在的锚点/页面（不做假链接）：
// 首页栏目用 /#how 等锚点，任何页面点回首页都成立。
// ============================================================

/** 品牌标记：方形纸片上的「行」字——像一枚印章，克制、可复用在 favicon/OG */
function BrandMark() {
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
        <Link href="/" className="brand" aria-label="行程规划师 首页">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">行程规划师</span>
            <span className="brand-sub">TRAVEL PLANNER</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label="主导航">
          <Link href="/#how">怎么工作</Link>
          <Link href="/#cap">产品能力</Link>
          <Link href="/#trust">数据可信</Link>
          <Link href="/#faq">常见问题</Link>
        </nav>

        <div className="site-header-actions">
          <Link href="/#faq" className="btn btn-ghost btn-sm">
            了解核验机制
          </Link>
          <Link href="/" className="btn btn-primary btn-sm">
            开始规划
          </Link>
        </div>
      </div>
    </header>
  );
}
