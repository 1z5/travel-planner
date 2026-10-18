// 城市/地区封面背景图。
//
// 两层机制：
// 1) 少量已核实有真实照片的城市 → Wikimedia 实拍图（CITY_IMAGES）。
// 2) 其它任意城市/地区 → 由城市名确定性生成的一张暗色渐变图（generatedCityImage）。
//
// 为什么未覆盖的城市用「生成图」而不是去搜一张网图：没有可靠的无 key 图床能对
// 任意城市返回**正确**的图，搜错图（把 A 地照片安到 B 地头上）等于制造幻觉，与
// 产品「不猜」的立场冲突。生成图是明确的「品牌化抽象背景」，不声称是某地实拍，
// 却能让任何输入都得到一张协调、稳定、断网也能显示的图。
//
// 曾经的坑：未覆盖城市统一走一张长城兜底图——用户选了「京都」却看到长城，张冠
// 李戴。已移除。

const W = "https://thumb.wikimedia.org/wikipedia/commons/thumb";

export const CITY_IMAGES: Record<string, string> = {
  成都: `${W}/2/20/Chengdu_skyline_June_2017.jpg/1920px-Chengdu_skyline_June_2017.jpg`,
  西安: `${W}/d/d7/Xi%27an_city_walls_%2889479%29.jpg/1920px-Xi%27an_city_walls_%2889479%29.jpg`,
  杭州: `${W}/f/fd/Hangzhou_Skyline_against_the_West_Lake.png/1920px-Hangzhou_Skyline_against_the_West_Lake.png`,
  厦门: `${W}/f/fe/Xiamen_night_Skyline_from_Gulangyu.JPG/1920px-Xiamen_night_Skyline_from_Gulangyu.JPG`,
  重庆: `${W}/f/f5/Chongqing_Skyline_At_Night.png/1920px-Chongqing_Skyline_At_Night.png`,
  苏州: `${W}/d/d5/Skyline_of_Suzhou_02.jpg/1920px-Skyline_of_Suzhou_02.jpg`,
};

// 精选色相对 [h1, h2]（HSL 色相），都调成暗色主题协调的搭配——避免全色相轮
// 随机取到难看或刺眼的组合。
const PALETTES: Array<[number, number]> = [
  [210, 265], // 蓝 → 紫
  [185, 215], // 青 → 蓝
  [25, 350],  // 橙 → 玫红
  [150, 190], // 绿 → 青
  [275, 320], // 紫 → 粉
  [40, 15],   // 金 → 橙
  [200, 280], // 蓝 → 紫罗兰
  [160, 120], // 青绿 → 绿
];

// 4 种线性渐变方向（x1,y1 → x2,y2），按哈希选，增加城市间的差异。
const DIRECTIONS: Array<[string, string, string, string]> = [
  ["0%", "0%", "100%", "100%"],
  ["100%", "0%", "0%", "100%"],
  ["0%", "100%", "100%", "0%"],
  ["50%", "0%", "50%", "100%"],
];

// FNV-1a 字符串哈希：稳定、无依赖，同一字符串永远同一结果。
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 由城市/地区名确定性生成一张暗色渐变背景图（data-URI SVG）。
 * 同一名字永远生成同一张；不同名字靠哈希选到不同色相对/方向/光晕位置。
 */
export function generatedCityImage(city: string): string {
  const h = hashStr(city || "travel");
  const [h1, h2] = PALETTES[h % PALETTES.length];
  const [dx1, dy1, dx2, dy2] = DIRECTIONS[(h >>> 3) % DIRECTIONS.length];
  // 光晕位置取不同 bit 段，与色相/方向去相关，让近邻名字也常有不同观感
  const gx1 = 18 + ((h >>> 5) % 26);
  const gy1 = 22 + ((h >>> 10) % 26);
  const gx2 = 70 + ((h >>> 15) % 22);
  const gy2 = 68 + ((h >>> 20) % 24);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'>` +
    `<defs>` +
    `<linearGradient id='b' x1='${dx1}' y1='${dy1}' x2='${dx2}' y2='${dy2}'>` +
    `<stop offset='0' stop-color='hsl(${h1},42%,17%)'/>` +
    `<stop offset='0.55' stop-color='hsl(${h2},38%,11%)'/>` +
    `<stop offset='1' stop-color='hsl(${h1},44%,14%)'/>` +
    `</linearGradient>` +
    `<radialGradient id='g1' cx='${gx1}%' cy='${gy1}%' r='55%'>` +
    `<stop offset='0' stop-color='hsl(${h1},72%,54%)' stop-opacity='0.40'/>` +
    `<stop offset='1' stop-color='hsl(${h1},72%,54%)' stop-opacity='0'/>` +
    `</radialGradient>` +
    `<radialGradient id='g2' cx='${gx2}%' cy='${gy2}%' r='50%'>` +
    `<stop offset='0' stop-color='hsl(${h2},68%,50%)' stop-opacity='0.36'/>` +
    `<stop offset='1' stop-color='hsl(${h2},68%,50%)' stop-opacity='0'/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width='1920' height='1080' fill='#0b0b12'/>` +
    `<rect width='1920' height='1080' fill='url(#b)'/>` +
    `<rect width='1920' height='1080' fill='url(#g1)'/>` +
    `<rect width='1920' height='1080' fill='url(#g2)'/>` +
    `</svg>`;
  // encodeURIComponent 会正确编码 # / % / 空格等，浏览器解码后还原成合法 SVG
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** 城市/地区封面图：已核实实拍图优先，否则确定性生成图。 */
export function cityImage(city: string): string {
  return CITY_IMAGES[city] ?? generatedCityImage(city);
}
