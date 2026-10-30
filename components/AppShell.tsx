import Link from "next/link";
import { BrandMark } from "./SiteHeader";
import { ThemeToggle } from "./ThemeToggle";

// ============================================================
// 产品壳（只在 (app) 路由组使用）。
//
// 和营销壳的区别：这里没有「怎么工作 / 产品能力 / 常见问题」的导航，也没有
// 三栏信任页脚——用户进入产品后只关心「我的行程 / 当前这趟」。
//
// 2026-10 改版（ATLAS v6）：
// - 顶栏从通栏纸带变成「悬浮玻璃指令条」（见 atlas-shell.css）：滚动时内容
//   从玻璃下穿过，品牌章与主页入口保持可达；
// - 顶部加 2px 滚动进度线（纯 CSS scroll-driven animation，无 JS）；
// - 右侧加主题开关（跟随系统 / 浅色 / 深色），产品面与营销面共用品牌章；
// - 顶栏仍不放「新建行程」按钮：新建入口收敛到首页主行动卡，避免三处重复。
// ============================================================

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      {/* 滚动进度线：instrument 的「当前位置」读数 */}
      <div className="at-progress" aria-hidden="true" />

      <header className="app-topbar">
        <div className="app-topbar-inner">
          <Link href="/" className="brand app-brand" aria-label="行程规划师 · 我的行程">
            <BrandMark />
            <span className="app-brand-name">行程规划师</span>
          </Link>

          <nav className="app-nav" aria-label="产品导航">
            <Link href="/">我的行程</Link>
          </nav>

          <div className="app-topbar-actions">
            <ThemeToggle />
          </div>
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
