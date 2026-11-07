// 展示用成品行程的稳定分享 token（client-safe，不含任何行程数据）。
//
// 为什么单独一个文件：首页、新建页、分享失效页需要一个「秒开真实成品」的链接，
// 但 demo/fixtures/index.ts 静态 import 了两条完整 fixture JSON（各几十 KB），
// 客户端组件直接引用会把整份行程打进首屏 bundle。
//
// 为什么是常量而不是运行时查表：这两个 token 对应仓库里真实生成、真实验真的
// 成品，本来就打算公开（DEMO.md 也直接给出）。单测 tests/lib/demo-links.test.ts
// 会钉住它们与 DEMO_FIXTURES 一致——重跑 demo:gen 生成新 token 后若忘了同步，
// 测试会立刻红，而不是让「看示例」按钮点了 404。

/** 苏州 3 天：故意保留体检问题的样本，用来演示「发现问题 → 一键顺延」。 */
export const DEMO_SHOWCASE_SHARE_ID = "share_Z5oYam8ahjqb";

/** 成都 4 天：已用确定性顺延打磨过的「修完之后」样本。 */
export const DEMO_POLISHED_SHARE_ID = "share_BP3e7AKOJ4ML";

/** 成品行程的只读分享页：秒开、验真、含体检凭据，不经过生成管线。 */
export function demoShareHref(shareId: string): string {
  return `/p/${shareId}`;
}
