import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { RouteTransition } from "@/components/RouteTransition";

// 公开说明和工具入口共用导航，行程操作使用产品壳。
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <RouteTransition>{children}</RouteTransition>
      <SiteFooter />
    </>
  );
}
