#!/usr/bin/env node
/**
 * 生成第三方声明（NOTICE.md）。
 *
 * 为什么需要：项目要作为专有产品分发（Docker 镜像 / SaaS），其中包含大量
 * 第三方开源组件。MIT/ISC 类要求保留版权声明，Apache-2.0 要求随分发附带
 * NOTICE 内容——"代码能跑"不等于"可以合法卖"。
 *
 * 数据源：package-lock.json（权威，含传递依赖）。只列许可证与版权归属，
 * 不复制各项目的完整 NOTICE 正文（需要时按链接去上游取）。
 *
 * 用法：node scripts/gen-notice.mjs   （提交 NOTICE.md 的变更前重跑一次）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

/**
 * lockfileVersion 3 的 packages：key 形如 "node_modules/foo" 或
 * "node_modules/foo/node_modules/bar"——**包名要从路径最后一段推导**
 * （只有 alias 包才带 name 字段，直接读 name 会得到 0 条）。
 * key 为 "" 的是根项目自身，跳过。
 */
function entries() {
  const out = [];
  for (const [key, info] of Object.entries(lock.packages ?? {})) {
    if (!key || !info?.version || info.link) continue;
    const name = info.name ?? key.split("node_modules/").pop();
    if (!name) continue;
    out.push({ name, version: info.version, license: info.license ?? "UNKNOWN" });
  }
  return out;
}

const all = entries();
const direct = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
]);
const runtime = all.filter((d) => direct.has(d.name));
const transitive = all.filter((d) => !direct.has(d.name));

const byLicense = (list) => {
  const m = new Map();
  for (const d of list) {
    const k = String(d.license);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(d);
  }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
};

const lines = [];
lines.push("# 第三方声明（Third-Party Notices）");
lines.push("");
lines.push("> 本文件由 `scripts/gen-notice.mjs` 依据 `package-lock.json` 生成，**请勿手改**。");
lines.push("> 升级依赖后重新生成并提交。");
lines.push("");
lines.push(
  "本项目（行程规划师）基于 [Apache-2.0](LICENSE) 许可开源，版权归作者所有。以下是随本项目分发的",
);
lines.push("第三方开源组件及其许可证。MIT/ISC/Zlib 等需保留其版权声明；Apache-2.0 需随分发");
lines.push("附带 NOTICE——本文件即为此目的维护。");
lines.push("");

lines.push("## 1. 直接依赖");
lines.push("");
lines.push("| 包 | 版本 | 许可证 |");
lines.push("| --- | --- | --- |");
for (const d of runtime.sort((a, b) => a.name.localeCompare(b.name))) {
  lines.push(`| ${d.name} | ${d.version} | ${d.license} |`);
}
lines.push("");

lines.push("## 2. 许可证分布（含传递依赖）");
lines.push("");
lines.push("| 许可证 | 数量 |");
lines.push("| --- | --- |");
for (const [lic, list] of byLicense(all)) lines.push(`| ${lic} | ${list.length} |`);
lines.push("");
lines.push(`传递依赖合计 ${transitive.length} 个；完整清单见 \`package-lock.json\`。`);
lines.push("");

lines.push("## 3. 字体");
lines.push("");
lines.push("Docker 运行层安装 `font-noto-cjk`（Noto Sans/Serif CJK），用于动态 OG 图的中文渲染。");
lines.push("Noto 字体遵循 [SIL Open Font License 1.1](https://openfontlicense.org/)，");
lines.push("随镜像分发时保留该许可与版权声明即可（本文件即声明）。");
lines.push("");

lines.push("## 4. 数据与服务归属");
lines.push("");
lines.push("- **POI / 营业时间 / 闭馆 / 评分 / 人均 / 路况**：高德开放平台（Web 服务 API）。");
lines.push("  在产品内展示时须标注「数据来源 高德开放平台」（已在结果页/分享页/页脚落实）。");
lines.push("- **生成引擎**：由 `LLM_BASE_URL` 指定的 OpenAI 兼容服务（默认 stepfun step-5）。");
lines.push("  输出内容的所有权与合规义务以你与该服务商的协议为准。");
lines.push("- **静态地图底图**：高德静态地图（经 `/api/map` 代理，不在客户端暴露 key）。");
lines.push("");

lines.push("## 5. 分发前自查");
lines.push("");
lines.push("- [ ] 依赖升级后重跑 `node scripts/gen-notice.mjs` 并提交");
lines.push("- [ ] Docker 镜像内未包含 `.env`、真实 key、测试种子数据");
lines.push("- [ ] 镜像内字体保留 OFL 许可（本文件）");
lines.push("- [ ] 产品内所有数据展示处标注高德来源");
lines.push("");

writeFileSync(path.join(ROOT, "NOTICE.md"), lines.join("\n"));
console.log(`NOTICE.md written: ${runtime.length} direct, ${all.length} total`);
