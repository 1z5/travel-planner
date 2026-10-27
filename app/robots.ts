import type { MetadataRoute } from "next";

// robots.txt：公开页面允许抓取；用户内容（/p /t /w /r）与接口不允许。
//
// 为什么不索引 /p 与 /t：分享链接里是用户自己的行程（城市/日期/偏好），
// 被搜索引擎收录等于把用户行程挂到公开搜索里——隐私红线。
const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://travel-planner-demo.onrender.com";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/new", "/about", "/cities", "/pricing", "/privacy", "/terms"],
        disallow: ["/p/", "/t/", "/w/", "/r/", "/api/"],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
