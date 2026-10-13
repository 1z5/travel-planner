// 城市封面图（Wikimedia Commons 真实照片，1920px）
// 未覆盖的城市走兜底图；接图床/CDN 是后续优化项

const W = "https://thumb.wikimedia.org/wikipedia/commons/thumb";

export const CITY_IMAGES: Record<string, string> = {
  成都: `${W}/2/20/Chengdu_skyline_June_2017.jpg/1920px-Chengdu_skyline_June_2017.jpg`,
  西安: `${W}/d/d7/Xi%27an_city_walls_%2889479%29.jpg/1920px-Xi%27an_city_walls_%2889479%29.jpg`,
  杭州: `${W}/f/fd/Hangzhou_Skyline_against_the_West_Lake.png/1920px-Hangzhou_Skyline_against_the_West_Lake.png`,
  厦门: `${W}/f/fe/Xiamen_night_Skyline_from_Gulangyu.JPG/1920px-Xiamen_night_Skyline_from_Gulangyu.JPG`,
  重庆: `${W}/f/f5/Chongqing_Skyline_At_Night.png/1920px-Chongqing_Skyline_At_Night.png`,
  苏州: `${W}/d/d5/Skyline_of_Suzhou_02.jpg/1920px-Skyline_of_Suzhou_02.jpg`,
};

export const DEFAULT_CITY_IMAGE = `${W}/f/fa/Great_Wall_of_China_July_2006.JPG/1920px-Great_Wall_of_China_July_2006.JPG`;

export function cityImage(city: string): string {
  return CITY_IMAGES[city] ?? DEFAULT_CITY_IMAGE;
}
