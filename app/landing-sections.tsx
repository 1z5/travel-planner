import {
  ListChecks, MapPinned, Route, Timer, CalendarPlus, Share2,
  HelpCircle, ChevronDown, Navigation, Map, Sparkles,
  Clock, Footprints, Wrench, Sun,
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
            <h3>真实世界逐点核查</h3>
            <p>景点餐厅过高德 POI 验真，取回真实营业时间与闭馆日；站点之间按你选的交通方式算真实路段——排一个周一闭馆的馆、或只留 15 分钟走 22 分钟的路，比没有推荐更糟。</p>
          </div>
          <div className="how-item">
            <span className="how-num">03</span>
            <h3>体检报告 + 一键修复</h3>
            <p>绕路、节奏、预算、天气、闭馆、时间轴接不上——所有风险摊开告诉你，能修的直接一键修（改完自动复检），修不了的老实说修不了。</p>
          </div>
        </div>
      </section>

      <section className="stats">
        <div className="stat"><span className="stat-num">20+</span><span className="stat-label">城市实测通过</span></div>
        <div className="stat"><span className="stat-num">7 类</span><span className="stat-label">真实世界体检</span></div>
        <div className="stat"><span className="stat-num">持久</span><span className="stat-label">分享链接保存</span></div>
      </section>

      <section className="how">
        <div className="legend">能力</div>
        <div className="cap-grid">
          <div className="cap-item"><ListChecks size={18} /><h3>结构化行程</h3><p>按天分时段：景点、餐饮、时长、花费、雨天备选，一页看全。</p></div>
          <div className="cap-item"><Map size={18} /><h3>真实路线地图</h3><p>每天的动线画在真实地图上：站点按顺序编号，距离与方位一眼看清，不再是一张示意图。</p></div>
          <div className="cap-item"><MapPinned size={18} /><h3>POI 真实性验核</h3><p>每个景点餐厅过高德 POI 搜索比对，不存在或已关门当场标注。</p></div>
          <div className="cap-item"><Clock size={18} /><h3>营业时间与闭馆日</h3><p>用高德真实营业时间逐点核对：博物馆周一闭馆、景区 17:00 停止入场、餐厅午休——到不了的当天就标出来，还附上真实评分与人均参考价。</p></div>
          <div className="cap-item"><Route size={18} /><h3>通勤距离矩阵</h3><p>站点之间用真实驾驶距离估算通勤，绕路当天就发现。</p></div>
          <div className="cap-item"><Footprints size={18} /><h3>时间轴可执行</h3><p>相邻两站留的时间够不够走？按真实路况算给你看，不够就报「时间接不上」，还能一键按路况顺延当天动线。</p></div>
          <div className="cap-item"><Timer size={18} /><h3>节奏体检</h3><p>按你选的轻松/适中/紧凑分档核对每日负荷，超标即预警。</p></div>
          <div className="cap-item"><Sparkles size={18} /><h3>行程可共编</h3><p>不满意某个景点就「换一个」，想换个过法就「一句话改这一天」——不用整份重新生成，改完自动复检。</p></div>
          <div className="cap-item"><Wrench size={18} /><h3>体检一键修复</h3><p>绕路 / 节奏 / 预算 / 天气 / 闭馆这类问题，点一下按钮就让 AI 只改那一天；时间轴接不上则确定性顺延（不调模型、不扣次数）。</p></div>
          <div className="cap-item"><Sun size={18} /><h3>行中模式</h3><p>出行当天打开专属链接：第一屏只有今天——现在在哪、下一站、怎么走、天气如何，下雨可一键改室内，每个点直接导航。</p></div>
          <div className="cap-item"><Sparkles size={18} /><h3>行程管家</h3><p>就着这份行程提问：这天来得及吗、下雨怎么办、预算花哪了。涉及修改只给一个具体建议，你点了才执行。</p></div>
          <div className="cap-item"><CalendarPlus size={18} /><h3>日历一键导出</h3><p>.ics 文件导入手机日历，每个行程点都是带时间的日程。</p></div>
          <div className="cap-item"><Share2 size={18} /><h3>持久分享链接</h3><p>链接不会随生成任务过期，对方看到的就是最新版本；也能打印成纸质行程或存 PDF。</p></div>
        </div>
      </section>

      <section className="faq">
        <div className="legend">常见问题</div>
        {[
          ["生成一份行程要多久？", "推理模型做约束规划通常 2-4 分钟，跨境目的地更久。页面有实时进度，不用守着；生成完可以一直留在「最近行程」里。若上游卡住不发数据，系统会在 10 分钟内中止并退还次数，不会让你无限等。"],
          ["景点和餐厅是真实存在的吗？", "是。每个点位都经过高德 POI 搜索验核，未命中的会在行程里明确标注，不会冒充真实场所。每天的真实地图用的也是验真拿到的坐标。"],
          ["营业时间和闭馆日是从哪来的？", "高德 POI 的真实营业时间（含周一闭馆、季节时段、最晚入场）。行程里每个点会核对「你的到点时间它开不开门」；拿不准的数据（比如复杂节假日规则）我们选择不告警，而不是瞎猜。节假日安排以官方公告为准。"],
          ["「时间接不上」是什么意思？", "相邻两个行程点之间留的时间，不够走完那段路（按你选的步行/骑行/驾车真实耗时算）。这类问题可以一键顺延：按真实路段时长重排当天时间轴，不调模型、不扣次数，毫秒级完成。"],
          ["体检发现的问题能自动修吗？", "能修的点一下就修：绕路、节奏、预算、天气、闭馆——服务端用模板化指令让 AI 只改那一天，改完自动重跑体检。修不了的不给按钮（未验真、境外无数据、硬约束漏排），不会制造「点了也没用」的假动作。"],
          ["支持哪些城市和天数？", "目前覆盖国内城市，1-7 天；区域环线（如川西环线）支持 1-10 天。5 天以上的长行程会逐日生成，天数陆续出现，不用干等全部完成。"],
          ["生成的行程可以修改吗？", "可以，而且不用重新生成：点某个景点的「换一个」保持同区域同类型替换，或对某一天输入一句「想轻松点、多安排室内」，AI 只改这一天并自动重跑体检。分享链接会同步到最新版本。"],
          ["旅行当天应该看哪个页面？", "用行程页的「行中模式」：/t/ 专属链接只显示今天——现在在哪、下一站、今日时间轴和真实路段、天气；下雨可以一键把今天改成室内路线，每个点都能直接导航。"],
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
        <span>国内城市 1-7 天 · POI / 营业时间 / 路况 / 地图数据来自高德开放平台</span>
      </footer>
    </>
  );
}
