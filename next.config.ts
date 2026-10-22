import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：Docker 部署只需 .next/standalone，镜像从 ~1GB 降到 ~150MB
  output: "standalone",
  // 开发服务器默认只放行 localhost 与启动时的 hostname（见 Next 文档
  // allowedDevOrigins）：用 127.0.0.1:3000 打开时 dev 资产/HMR 全部被拦，
  // 页面 SSR 出来但永远不 hydrate——表单点不动、入场动画停在 opacity:0，
  // 看起来像「首页坏了」。这是开发期才有的问题（生产无 dev 资产），但
  // 一旦用 127.0.0.1 调试就会踩到，所以显式放行。
  allowedDevOrigins: ["127.0.0.1"],
  // distDir 可被环境变量覆盖：测试编排器会让多台 dev 服务器各用独立
  // distDir，否则共用 .next 会互相踩踏构建状态（随机编译失败/挂起）
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    // 面向陌生人的公共部署：最小安全头集
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
