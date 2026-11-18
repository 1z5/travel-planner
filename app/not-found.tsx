import Link from "next/link";

export default function NotFound() {
  return (
    <main className="container">
      <div className="fault-page">
        <h1 className="fault-title">这个页面不存在</h1>
        <p className="fault-desc">请检查地址。如果这是别人发来的行程，可以请对方重新发送链接。</p>
        <div className="fault-actions">
          <Link href="/" className="btn btn-primary btn-sm">
            我的行程
          </Link>
          <Link href="/about" className="btn btn-sm">
            了解项目
          </Link>
        </div>
      </div>
    </main>
  );
}
