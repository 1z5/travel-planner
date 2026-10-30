import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

// ============================================================
// 营销站顶栏（只在 (marketing) 路由组使用，服务端组件 + 一个客户端主题开关）。
//
// ATLAS v6：与产品壳 .app-topbar 同族的「悬浮玻璃指令条」——
// 圆角胶囊 + 1px 高光边 + 背后内容透出；导航条目是玻璃胶囊。
// 右侧 = 仪器状态字（装饰）+ 主题开关 + 我的行程 + 主 CTA。
//
// 手机端刻意不做汉堡：没有可展开菜单的汉堡是一个打不开的死按钮。
// ≤860px 直接收成「品牌章 + 主题开关 + 主 CTA」，导航靠页内区块与页脚可达。
// ============================================================

/** 品牌标记：方形「印章」里的「行」字——可复用在 favicon/OG，产品壳也用同一个 */
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
          <Link href="/verify">行程体检</Link>
          <Link href="/about#how">怎么工作</Link>
          <Link href="/about#cap">产品能力</Link>
          <Link href="/about#trust">数据可信</Link>
          <Link href="/about#faq">常见问题</Link>
        </nav>

        <div className="site-header-actions">
          <span className="site-header-status at-mono" aria-hidden="true">
            <span className="site-status-dot" />
            FACT-FIRST
          </span>
          <ThemeToggle />
          <Link href="/" className="btn btn-ghost btn-sm site-header-mine">
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
