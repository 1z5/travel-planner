import { AppShell } from "@/components/AppShell";
import { RouteTransition } from "@/components/RouteTransition";

// 产品路由组：/、/new、/p/[id]、/t/[id]、/r/[id] 共享紧凑应用壳。
// 营销页（/about）在 (marketing) 组，用另一套壳。
//
// 页面内容包在 RouteTransition 里（ATLAS v6）：路由切换走浏览器原生
// View Transitions，顶栏是持久元素、不参与动画。
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <RouteTransition>{children}</RouteTransition>
    </AppShell>
  );
}
