// 全局固定背景图（品牌化抽象渐变，data-URI SVG）。
//
// 曾经这里按城市切换：6 个城市用 Wikimedia 实拍图、其余城市用城市名哈希生成
// 渐变。改为固定的原因（用户反馈）：背景不该抢注意力，更不该让「不会看地图」
// 的用户面对一张张陌生的城市照片——一张沉稳的固定底更像"产品"，也更稳。
//
// 为什么用内联 SVG 而不是外链图床：
// 1) 零外部依赖——断网/图床挂掉都不会出现裂图或白底；
// 2) 不声称是任何城市的实拍，杜绝"张冠李戴"（早期未覆盖城市统一走长城兜底图，
//    用户选京都看到长城，已移除）；
// 3) 体积极小（几行 SVG），随包下发，无额外请求。

// 固定品牌渐变：暖橙（与 --accent 同色系）在近黑底上的一束光晕，
// 方向/位置固定，不随任何输入变化。
const BRAND_SVG =
  `<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>` +
  `<defs>` +
  `<radialGradient id='glow' cx='26%' cy='24%' r='62%'>` +
  `<stop offset='0' stop-color='#fb923c' stop-opacity='0.30'/>` +
  `<stop offset='0.55' stop-color='#c2410c' stop-opacity='0.12'/>` +
  `<stop offset='1' stop-color='#fb923c' stop-opacity='0'/>` +
  `</radialGradient>` +
  `<radialGradient id='glow2' cx='82%' cy='86%' r='55%'>` +
  `<stop offset='0' stop-color='#0ea5e9' stop-opacity='0.14'/>` +
  `<stop offset='1' stop-color='#0ea5e9' stop-opacity='0'/>` +
  `</radialGradient>` +
  `<linearGradient id='base' x1='0%' y1='0%' x2='100%' y2='100%'>` +
  `<stop offset='0' stop-color='#0c0c10'/>` +
  `<stop offset='1' stop-color='#09090b'/>` +
  `</linearGradient>` +
  `</defs>` +
  `<rect width='1920' height='1080' fill='url(#base)'/>` +
  `<rect width='1920' height='1080' fill='url(#glow)'/>` +
  `<rect width='1920' height='1080' fill='url(#glow2)'/>` +
  `</svg>`;

/** 全局固定背景图（data-URI SVG）。不随城市/任何输入变化。 */
export const BRAND_BACKGROUND = `data:image/svg+xml,${encodeURIComponent(BRAND_SVG)}`;

/**
 * 保留此函数名以最小化调用方改动，但语义已变为"返回固定背景"——参数忽略。
 *
 * 之所以保留函数而非让调用方直接用常量：masthead 用 `key={city}` 做切换动画，
 * 若改成常量 src，React 会认为 img 从未变化、不再重播入场动画。保留
 * cityImage(city) 让 key 仍随城市变化（动画照旧），只是图不再变。
 */
export function cityImage(_city: string): string {
  return BRAND_BACKGROUND;
}
