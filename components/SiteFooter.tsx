import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-bottom">
        <nav className="site-footer-links" aria-label="页脚导航">
          <Link href="/about">关于</Link>
          <Link href="/verify">开放验真台</Link>
          <Link href="/privacy">隐私政策</Link>
          <Link href="/terms">使用条款</Link>
        </nav>
        <span>地图和地点资料来自高德开放平台</span>
      </div>
    </footer>
  );
}
