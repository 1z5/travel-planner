import Link from "next/link";

// ============================================================
// 全站页脚（服务端组件，零客户端 JS）。
//
// 企业级产品的页脚不是装饰：它承载「数据来源 / 隐私 / 测试口径」这些
// 建立信任的信息。这里只写真实存在的内容（数据源、自动化测试规模、
// 隐私边界），不编造公司信息、备案号或 SLA。
// ============================================================

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="footer-brand">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              行
            </span>
            <span className="brand-text">
              <span className="brand-name">行程规划师</span>
              <span className="brand-sub">TRAVEL PLANNER</span>
            </span>
          </div>
          <p className="footer-desc">
            先核验真实世界（POI / 营业时间 / 通勤），再让模型排行程。每一份行程都标注核验状态，
            体检问题摊开给你，改不改由你决定。
          </p>
        </div>

        <nav className="footer-cols" aria-label="页脚导航">
          <div className="footer-col">
            <h4>产品</h4>
            <ul>
              <li>
                <Link href="/#how">怎么工作</Link>
              </li>
              <li>
                <Link href="/#cap">产品能力</Link>
              </li>
              <li>
                <Link href="/#faq">常见问题</Link>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>数据与核验</h4>
            <ul>
              <li>
                <Link href="/#trust">数据来源</Link>
              </li>
              <li>
                <Link href="/#trust">核验与体检</Link>
              </li>
              <li>
                <Link href="/#trust">隐私边界</Link>
              </li>
            </ul>
          </div>
          <div className="footer-col">
            <h4>工程</h4>
            <ul>
              <li>
                <Link href="/#trust">测试与验收</Link>
              </li>
              <li>
                <Link href="/#trust">诚实降级</Link>
              </li>
              <li>
                <Link href="/#faq">支持范围</Link>
              </li>
            </ul>
          </div>
        </nav>
      </div>

      <div className="site-footer-bottom">
        <span>© 2026 行程规划师</span>
        <span>POI / 营业时间 / 路况数据来自高德开放平台 · 生成引擎 step-5</span>
      </div>
    </footer>
  );
}
