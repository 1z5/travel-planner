// 空模块：让 Vitest 能 import 顶部带 `import "server-only"` 的服务端模块
// （lib/amap.ts、lib/validate.ts、lib/planner.ts 等）。
//
// 为什么需要：`server-only` 不是真实依赖，而是 Next 的 bundler 在构建时
// 别名到 next/dist/compiled/server-only/empty.js 的虚拟模块；它的默认入口
// index.js 会直接 throw，Vite/Vitest 的解析器既找不到这个模块名、也不该
// 真的抛错。这里用仓库内空文件 + vitest.config.mts 的 resolve.alias 指过来，
// 避免把 next 的内部路径写死（升级 Next 时会漂）。
export {};
