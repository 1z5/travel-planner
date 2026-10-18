import {
  ListChecks, MapPinned, Route, Timer, CalendarPlus, Share2,
  HelpCircle, ChevronDown, Navigation,
} from "lucide-react";

// ============================================================
// 首页静态营销区块：怎么做到的 / 数据带 / 能力矩阵 / FAQ / 页脚。
//
// 故意**不带** "use client"——这些内容零交互、零状态，原来却因为整页
// 是 client component 而被打进客户端包、每次加载都要 hydrate。
// 抽成服务端组件后只在服务端渲染成 HTML 发给浏览器。
// ============================================================

export function LandingSections() {
  return (
    <>
      <section className="how">
        <div className="legend">怎么做到的</div>
        <div className="how-grid">
          <div className="how-item">
            <span className="how-num">01</span>
            <h3>约束优先，不是聊天</h3>
            <p>预算、时间、地理、POI 真实性都是硬约束。模型只输出结构化行程，没有自由发挥的空间。</p>
          </div>
          <div className="how-item">
            <span className="how-num">02</span>
            <h3>逐点事实核查</h3>
            <p>每个景点、餐厅过高德 POI 验真，站点之间用真实驾驶距离估算通勤——排一个已关门的店，比没有推荐更糟。</p>
          </div>
          <div className="how-item">
            <span className="how-num">03</span>
            <h3>体检报告，不藏着</h3>
            <p>绕路、节奏失衡、预算超标、必游地漏排——所有风险摊开告诉你，改不改由你决定。</p>
          </div>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span className="stat-num">20+</span><span className="stat-label">城市实测通过</span></div>
        <div className="stat"><span className="stat-num">4 层</span><span className="stat-label">幻觉治理机制</span></div>
        <div className="stat"><span className="stat-num">100%</span><span className="stat-label">答案引用可溯源</span></div>
      </section>

      <section className="how">
        <div className="legend">能力</div>
        <div className="cap-grid">
          <div className="cap-item"><ListChecks size={18} /><h3>结构化行程</h3><p>按天分时段：景点、餐饮、时长、花费、雨天备选，一页看全。</p></div>
          <div className="cap-item"><MapPinned size={18} /><h3>POI 真实性验核</h3><p>每个景点餐厅过高德 POI 搜索比对，不存在或已关门当场标注。</p></div>
          <div className="cap-item"><Route size={18} /><h3>通勤距离矩阵</h3><p>站点之间用真实驾驶距离估算通勤，绕路当天就发现。</p></div>
          <div className="cap-item"><Timer size={18} /><h3>节奏体检</h3><p>按你选的轻松/适中/紧凑分档核对每日负荷，超标即预警。</p></div>
          <div className="cap-item"><CalendarPlus size={18} /><h3>日历一键导出</h3><p>.ics 文件导入手机日历，每个行程点都是带时间的日程。</p></div>
          <div className="cap-item"><Share2 size={18} /><h3>分享与导出</h3><p>一个链接分享整份行程，或复制 Markdown 存进笔记。</p></div>
          <div className="cap-item"><Navigation size={18} /><h3>行中陪同</h3><p>旅途中打开行程：自动定位「今天」、按时间标出「现在/下一站」、重查今天天气、定位算你离各景点多远。</p></div>
        </div>
      </section>

      <section className="faq">
        <div className="legend">常见问题</div>
        {[
          ["生成一份行程要多久？", "推理模型做约束规划通常 2-4 分钟，跨境目的地更久。页面有实时进度，不用守着。"],
          ["景点和餐厅是真实存在的吗？", "是。每个点位都经过高德 POI 搜索验核，未命中的会在行程里明确标注，不会冒充真实场所。"],
          ["支持哪些城市和天数？", "目前覆盖国内城市，1-7 天。5 天以上的长行程会逐日生成，天数陆续出现，不用干等全部完成。"],
          ["生成的行程可以修改吗？", "可以。所有内容支持复制 Markdown 自行编辑，也可以换个节奏或偏好重新生成。"],
        ].map(([q, a]) => (
          <details key={q}>
            <summary><HelpCircle size={15} />{q}<ChevronDown size={15} className="faq-chevron" /></summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <footer className="foot">
        <span>行程规划师 · AI 行程规划平台</span>
        <span>国内城市 1-7 天 · POI 数据来自高德开放平台</span>
      </footer>
    </>
  );
}
