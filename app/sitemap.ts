import type { MetadataRoute } from "next";
import { CITY_TEMPLATES } from "@/lib/city-templates";

// 站点地图（SEO）：只列可以通过自然搜索进来的公开页面。
//
// 为什么现在做：B2 城市模板是获取层，没有 sitemap 搜索引擎发现成本高；
// 但 /p、/t、/w 分享链接是用户私有内容，**不进 sitemap**（不该被索引）。
// baseUrl 走 NEXT_PUBLIC_SITE_URL（演示站与正式域名各自配置），未配置时用
// 演示站默认值——宁可指错也不编一个不存在的域名。
const BASE = process.env.NEXT_PUBLIC_SITE_URL || "https://travel-planner-demo.onrender.com";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const staticRoutes: Array<{
    path: string;
    priority: number;
    changeFrequency: "daily" | "weekly" | "monthly";
  }> = [
    { path: "/", priority: 1, changeFrequency: "daily" },
    { path: "/new", priority: 0.9, changeFrequency: "weekly" },
    // 开放体检台（Trip Check）：公开工具页，第三方开发者也是从搜索引擎找过来的
    { path: "/verify", priority: 0.8, changeFrequency: "weekly" },
    { path: "/about", priority: 0.7, changeFrequency: "monthly" },
    { path: "/cities", priority: 0.8, changeFrequency: "weekly" },
    { path: "/pricing", priority: 0.5, changeFrequency: "monthly" },
    { path: "/privacy", priority: 0.2, changeFrequency: "monthly" },
    { path: "/terms", priority: 0.2, changeFrequency: "monthly" },
  ];

  return [
    ...staticRoutes.map((r) => ({
      url: `${BASE}${r.path}`,
      lastModified: now,
      changeFrequency: r.changeFrequency,
      priority: r.priority,
    })),
    // 城市模板详情：每个城市一个 URL（SEO 长尾入口）
    ...CITY_TEMPLATES.map((c) => ({
      url: `${BASE}/cities/${c.slug}`,
      lastModified: now,
      changeFrequency: "weekly" as const,
      priority: 0.7,
    })),
  ];
}
