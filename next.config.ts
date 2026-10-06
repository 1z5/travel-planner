import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：Docker 部署只需 .next/standalone，镜像从 ~1GB 降到 ~150MB
  output: "standalone",
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
