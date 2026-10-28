import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // standalone：Docker 部署只需 .next/standalone，镜像从 ~1GB 降到 ~150MB
  output: "standalone",
  // 断网检测：导航/RSC 请求失败时保持 pending 并在恢复后重试，同时给
  // useOffline() hook 供前端展示「当前离线」（行中场景：地铁/境外没信号）。
  // 实验特性，但 Next 16 文档提供明确契约；真机行为由 gate:visual + 手动断网验证。
  experimental: {
    useOffline: true,
  },
  // 开发服务器默认只放行 localhost 与启动时的 hostname（见 Next 文档
  // allowedDevOrigins）：用 127.0.0.1:3000 打开时 dev 资产/HMR 全部被拦，
  // 页面 SSR 出来但永远不 hydrate——表单点不动、入场动画停在 opacity:0，
  // 看起来像「首页坏了」。这是开发期才有的问题（生产无 dev 资产），但
  // 一旦用 127.0.0.1 调试就会踩到，所以显式放行。
  allowedDevOrigins: ["127.0.0.1"],
  // distDir 可被环境变量覆盖：测试编排器会让多台 dev 服务器各用独立
  // distDir，否则共用 .next 会互相踩踏构建状态（随机编译失败/挂起）
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // 不暴露 Next 版本（扫描器按版本找已知漏洞的第一步）
  poweredByHeader: false,
  async headers() {
    // 面向陌生人的公共部署：安全头集。
    //
    // CSP 的口径（刻意不用 nonce，用 'unsafe-inline'）：
    // - 站点自身不执行用户输入，XSS 面主要来自「POI 名称/理由」等模型输出文本，
    //   而 React 默认转义 + 这些字段都会经过服务端校验，脚本注入面很小；
    // - framer-motion 的入场动画靠内联 style；Next 的 hydration 脚本在部分版本
    //   也需要 'unsafe-inline'。为了不把产品搞挂，这里取「可用的严格」而非
    //   「最严但会坏」；真正的加固点是输入白名单（app/api/plan 已有）与服务端转义。
    // - 地图/OG 图片都走本站 /api/map 代理，所以 img-src 不需要放行高德域名
    //   （key 也不出服务端）；data: 给内嵌 SVG/占位图。
    // - 'unsafe-eval' 只在开发环境放行：React 在 development 下要用 eval 做
    //   Fast Refresh（生产构建不需要）。加上它生产就白紧了，所以按 NODE_ENV 区分。
    const isDev = process.env.NODE_ENV !== "production";
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

    return [
      // 私页（分享/行中/工作台/报告）不允许被索引：robots.txt 只是协议，搜索引擎/聚合器
      // 可能不遵守；X-Robots-Tag 是响应级强制口径（审计 R13）。
      {
        source: "/(p|t|w|r)/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, noarchive" }],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
          // 进程隔离/资源隔离：本应用不需要被跨源 window 引用，也不希望被嵌入
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          // HSTS 只在 HTTPS 下有意义；没有自定义域名/证书时先不开，
          // 否则 http 环境会被浏览器记住并强制跳 https（本地开发会坏）。
          // 生产（Render 注入 RENDER_EXTERNAL_URL=https://… 或显式 NEXT_PUBLIC_SITE_URL）
          // 才下发；本地/预览 http 环境保持关闭。
          ...((
            process.env.NEXT_PUBLIC_SITE_URL ??
            process.env.RENDER_EXTERNAL_URL ??
            ""
          ).startsWith("https://")
            ? [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=31536000; includeSubDomains",
                },
              ]
            : []),
        ],
      },
    ];
  },
};

export default nextConfig;
