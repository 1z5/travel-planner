import Link from "next/link";
import { BrandMark } from "./SiteHeader";

// ============================================================
// 产品壳（只在 (app) 路由组使用）。
//
// 和营销壳的区别：这里没有「怎么工作 / 产品能力 / 常见问题」的导航，也没有
// 三栏信任页脚——用户进入产品后只关心「我的行程 / 新建 / 当前这趟」。
// 品牌只做一个小号入口，不抢页面主任务。
// ============================================================

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="app-topbar-inner">
          <Link href="/" className="brand app-brand" aria-label="行程规划师 · 我的行程">
            <BrandMark />
            <span className="app-brand-name">行程规划师</span>
          </Link>

          <nav className="app-nav" aria-label="产品导航">
            <Link href="/">我的行程</Link>
            <Link href="/about">关于产品</Link>
          </nav>

          <Link href="/new" className="btn btn-primary btn-sm app-new-btn">
            + 新建行程
          </Link>
        </div>
      </header>
      {children}
      {/* 法务入口：产品页没有营销页脚，但隐私政策/用户协议必须可达（ToC 合规） */}
      <footer className="app-foot">
        <div className="app-foot-inner">
          <span>© 2026 行程规划师</span>
          <Link href="/about">关于产品</Link>
          <Link href="/privacy">隐私政策</Link>
          <Link href="/terms">用户协议</Link>
          <span>POI / 营业时间 / 路况数据来自高德开放平台</span>
        </div>
      </footer>
    </div>
  );
}
