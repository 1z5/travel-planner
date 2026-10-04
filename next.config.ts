import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：Docker 部署只需 .next/standalone，镜像从 ~1GB 降到 ~150MB
  output: "standalone",
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
