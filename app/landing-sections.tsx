import {
  ListChecks, MapPinned, Route, Timer, CalendarPlus, Share2,
  HelpCircle, ChevronDown, Navigation, Map, Sparkles, Printer,
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
        <div className="stat"><span className="stat-num">持久</span><span className="stat-label">分享链接保存</span></div>
      </section>

      <section className="how">
        <div className="legend">能力</div>
        <div className="cap-grid">
          <div className="cap-item"><ListChecks size={18} /><h3>结构化行程</h3><p>按天分时段：景点、餐饮、时长、花费、雨天备选，一页看全。</p></div>
          <div className="cap-item"><Map size={18} /><h3>真实路线地图</h3><p>每天的动线画在真实地图上：站点按顺序编号，距离与方位一眼看清，不再是一张示意图。</p></div>
          <div className="cap-item"><MapPinned size={18} /><h3>POI 真实性验核</h3><p>每个景点餐厅过高德 POI 搜索比对，不存在或已关门当场标注。</p></div>
          <div className="cap-item"><Route size={18} /><h3>通勤距离矩阵</h3><p>站点之间用真实驾驶距离估算通勤，绕路当天就发现。</p></div>
          <div className="cap-item"><Timer size={18} /><h3>节奏体检</h3><p>按你选的轻松/适中/紧凑分档核对每日负荷，超标即预警。</p></div>
          <div className="cap-item"><Sparkles size={18} /><h3>行程可共编</h3><p>不满意某个景点就「换一个」，想换个过法就「一句话改这一天」——不用整份重新生成，改完自动复检。</p></div>
          <div className="cap-item"><CalendarPlus size={18} /><h3>日历一键导出</h3><p>.ics 文件导入手机日历，每个行程点都是带时间的日程。</p></div>
          <div className="cap-item"><Share2 size={18} /><h3>持久分享链接</h3><p>链接不会随生成任务过期，对方看到的就是最新版本；也能打印成纸质行程或存 PDF。</p></div>
          <div className="cap-item"><Navigation size={18} /><h3>行中陪同</h3><p>旅途中打开行程：自动定位「今天」、按时间标出「现在/下一站」、重查今天天气、定位算你离各景点多远，一键导航。</p></div>
        </div>
      </section>

      <section className="faq">
        <div className="legend">常见问题</div>
        {[
          ["生成一份行程要多久？", "推理模型做约束规划通常 2-4 分钟，跨境目的地更久。页面有实时进度，不用守着；生成完可以一直留在「最近行程」里。"],
          ["景点和餐厅是真实存在的吗？", "是。每个点位都经过高德 POI 搜索验核，未命中的会在行程里明确标注，不会冒充真实场所。每天的真实地图用的也是验真拿到的坐标。"],
          ["支持哪些城市和天数？", "目前覆盖国内城市，1-7 天；区域环线（如川西环线）支持 1-10 天。5 天以上的长行程会逐日生成，天数陆续出现，不用干等全部完成。"],
          ["生成的行程可以修改吗？", "可以，而且不用重新生成：点某个景点的「换一个」保持同区域同类型替换，或对某一天输入一句「想轻松点、多安排室内」，AI 只改这一天并自动重跑体检。分享链接会同步到最新版本。"],
          ["分享出去的链接会过期吗？", "不会。行程生成完成即持久化保存（生产 Postgres 模式不设过期时间），旧版本的 2 小时链接也已兼容。"],
        ].map(([q, a]) => (
          <details key={q}>
            <summary><HelpCircle size={15} />{q}<ChevronDown size={15} className="faq-chevron" /></summary>
            <p>{a}</p>
          </details>
        ))}
      </section>

      <footer className="foot">
        <span>行程规划师 · AI 行程规划平台</span>
        <span>国内城市 1-7 天 · POI 与地图数据来自高德开放平台</span>
      </footer>
    </>
  );
}
