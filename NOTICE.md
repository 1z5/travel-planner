# 第三方声明（Third-Party Notices）

> 本文件由 `scripts/gen-notice.mjs` 依据 `package-lock.json` 生成，**请勿手改**。
> 升级依赖后重新生成并提交。

本项目（行程规划师）为专有软件，见 [LICENSE](LICENSE)。以下是随本项目分发的
第三方开源组件及其许可证。MIT/ISC/Zlib 等需保留其版权声明；Apache-2.0 需随分发
附带 NOTICE——本文件即为此目的维护。

## 1. 直接依赖

| 包                          | 版本    | 许可证     |
| --------------------------- | ------- | ---------- |
| @eslint/js                  | 10.0.1  | MIT        |
| @prisma/adapter-pg          | 7.10.1  | Apache-2.0 |
| @prisma/client              | 7.10.1  | Apache-2.0 |
| @testing-library/jest-dom   | 7.0.1   | MIT        |
| @testing-library/react      | 16.3.3  | MIT        |
| @testing-library/user-event | 14.6.8  | MIT        |
| @types/node                 | 22.20.5 | MIT        |
| @types/react                | 19.3.0  | MIT        |
| @types/react-dom            | 19.3.0  | MIT        |
| @vitejs/plugin-react        | 6.1.2   | MIT        |
| @vitest/coverage-v8         | 5.0.5   | MIT        |
| eslint                      | 10.13.0 | MIT        |
| eslint-config-prettier      | 10.1.8  | MIT        |
| framer-motion               | 14.3.0  | MIT        |
| globals                     | 17.13.0 | MIT        |
| husky                       | 9.1.7   | MIT        |
| jsdom                       | 30.1.3  | MIT        |
| lint-staged                 | 17.6.0  | MIT        |
| lucide-react                | 1.59.0  | ISC        |
| next                        | 16.4.2  | MIT        |
| openai                      | 7.36.0  | Apache-2.0 |
| prettier                    | 3.9.10  | MIT        |
| prisma                      | 7.10.1  | Apache-2.0 |
| react                       | 19.3.1  | MIT        |
| react-dom                   | 19.3.1  | MIT        |
| typescript                  | 7.0.2   | Apache-2.0 |
| vitest                      | 5.0.5   | MIT        |
| zod                         | 4.6.7   | MIT        |

## 2. 许可证分布（含传递依赖）

| 许可证                                   | 数量 |
| ---------------------------------------- | ---- |
| MIT                                      | 281  |
| Apache-2.0                               | 74   |
| ISC                                      | 30   |
| MPL-2.0                                  | 12   |
| LGPL-3.0-or-later                        | 10   |
| BSD-2-Clause                             | 9    |
| BSD-3-Clause                             | 5    |
| Apache-2.0 AND LGPL-3.0-or-later         | 3    |
| MIT-0                                    | 2    |
| BlueOak-1.0.0                            | 2    |
| Unlicense                                | 2    |
| Apache-2.0 AND LGPL-3.0-or-later AND MIT | 1    |
| MIT and ISC                              | 1    |
| CC-BY-4.0                                | 1    |
| EPL-2.0                                  | 1    |
| CC0-1.0                                  | 1    |
| 0BSD                                     | 1    |

传递依赖合计 408 个；完整清单见 `package-lock.json`。

## 3. 字体

Docker 运行层安装 `font-noto-cjk`（Noto Sans/Serif CJK），用于动态 OG 图的中文渲染。
Noto 字体遵循 [SIL Open Font License 1.1](https://openfontlicense.org/)，
随镜像分发时保留该许可与版权声明即可（本文件即声明）。

## 4. 数据与服务归属

- **POI / 营业时间 / 闭馆 / 评分 / 人均 / 路况**：高德开放平台（Web 服务 API）。
  在产品内展示时须标注「数据来源 高德开放平台」（已在结果页/分享页/页脚落实）。
- **生成引擎**：由 `LLM_BASE_URL` 指定的 OpenAI 兼容服务（默认 stepfun step-5）。
  输出内容的所有权与合规义务以你与该服务商的协议为准。
- **静态地图底图**：高德静态地图（经 `/api/map` 代理，不在客户端暴露 key）。

## 5. 分发前自查

- [ ] 依赖升级后重跑 `node scripts/gen-notice.mjs` 并提交
- [ ] Docker 镜像内未包含 `.env`、真实 key、测试种子数据
- [ ] 镜像内字体保留 OFL 许可（本文件）
- [ ] 产品内所有数据展示处标注高德来源
