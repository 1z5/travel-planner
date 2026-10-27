import Link from "next/link";
import { BrandMark } from "./SiteHeader";

// ============================================================
// 产品壳（只在 (app) 路由组使用）。
//
// 和营销壳的区别：这里没有「怎么工作 / 产品能力 / 常见问题」的导航，也没有
// 三栏信任页脚——用户进入产品后只关心「我的行程 / 当前这趟」。
//
// 2026-10 改版（用户反馈）：
// - 顶栏移除「关于产品」——它不是产品动作，页脚已有合规/介绍入口；
// - 顶栏移除「新建行程」按钮——它与页头、空态 CTA 三处重复，新建入口收敛到
//   首页的「主行动卡」（做得更显眼、更有特色），顶栏只保留导航。
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
          </nav>
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
