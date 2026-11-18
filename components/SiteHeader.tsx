import Link from "next/link";
import { Compass } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

/** 营销与产品入口共享同一罗盘标记。 */
export function BrandMark() {
  return (
    <span className="companion-brand-mark" aria-hidden="true">
      <Compass size={21} />
    </span>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="brand" aria-label="AI Travel Companion · 我的行程">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-name">AI Travel Companion</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label="主导航">
          <Link href="/verify">开放验真台</Link>
          <Link href="/cities">城市模板</Link>
          <Link href="/about">关于</Link>
        </nav>

        <div className="site-header-actions">
          <ThemeToggle />
          <Link href="/new" className="btn btn-primary btn-sm">
            新建行程
          </Link>
        </div>
      </div>
    </header>
  );
}
