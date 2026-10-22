"use client";

import { useEffect } from "react";

// 客户端错误边界：渲染/交互异常时的兜底页。
// 企业级产品的错误页要说清「出了什么、你的数据没丢、可以怎么办」——
// 而不是把 React 的错误堆栈直接甩给用户。错误详情保留在控制台，
// 页面只给可行动的信息。
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] 页面渲染异常", error);
  }, [error]);

  return (
    <main className="container">
      <div className="fault-page">
        <div className="fault-eyebrow">ERROR · 页面出错了</div>
        <h1 className="fault-title">刚才这一步没走完</h1>
        <p className="fault-desc">
          页面渲染时遇到了意外错误。<strong>你已生成的行程保存在服务端，不会丢失</strong>
          （分享链接、最近行程都仍然有效）。可以先重试；如果反复出现，回首页重新进入。
        </p>
        {error.digest && <p className="fault-code">错误编号：{error.digest}</p>}
        <div className="fault-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={reset}>
            重试这一步
          </button>
          <a href="/" className="btn btn-sm">
            回首页
          </a>
        </div>
      </div>
    </main>
  );
}
