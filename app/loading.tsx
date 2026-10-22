// 路由级 loading：服务端渲染等待时先给骨架，而不是空白页。
// 只画与数据无关的版式骨架（标题条 + 内容块），不假装任何具体内容。
export default function Loading() {
  return (
    <main className="container">
      <div className="route-skeleton" aria-busy="true" aria-label="页面加载中">
        <div className="sk-line sk-eyebrow" />
        <div className="sk-line sk-title" />
        <div className="sk-line sk-sub" />
        <div className="sk-card" />
        <div className="sk-card sk-card-short" />
      </div>
    </main>
  );
}
