import { HomeClient } from "./home-client";
import { LandingSections } from "./landing-sections";

// 首页 = 服务端外壳 + 客户端表单。
//
// 营销/FAQ/页脚（LandingSections）以 children 形式由本服务端组件传给
// 客户端组件，这样这部分 JS 完全不进客户端包。踩过的坑：client component
// **直接 import** 的模块仍会被打进客户端包（已实测确认——静态文案出现在
// .next/static/chunks/app/page-*.js 里），只有 children 传递才是真正的
// 服务端组件边界。
export default function Home() {
  return (
    <HomeClient>
      <LandingSections />
    </HomeClient>
  );
}
