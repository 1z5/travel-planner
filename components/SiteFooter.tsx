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
        <span>在线地图和地点检索由高德开放平台提供</span>
      </div>
    </footer>
  );
}
