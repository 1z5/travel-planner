import type { Metadata } from "next";
import Link from "next/link";
import { TripCheckPlayground } from "@/components/TripCheckPlayground";
import {
  TRIP_CHECK_ENGINE_VERSION,
  TRIP_CHECK_RULESET_VERSION,
  TRIP_CHECK_SPEC_VERSION,
} from "@/lib/verify/types";

// /verify 公开体验台：Trip Check 开放标准的「看得见」入口。
//
// 为什么放在营销路由组：它是给第一次接触这个产品的人用的（「先核验再生成」的证据），
// 不是登录后的产品功能；自动挂 SiteHeader/SiteFooter。
// 页面只做壳与说明，交互在客户端组件（TripCheckPlayground）；判定逻辑一行都不在 UI。

export const metadata: Metadata = {
  title: "行程体检 — 任何 AI 行程先过一遍 — 行程规划师",
  description:
    "把任何 AI 生成的行程 JSON 粘进来，用确定性规则引擎复算：结构自洽性（时间轴/节奏/预算）与事实核验（地点/营业时间/来源覆盖）两轴分开，附可复算凭据。免登录、不落库、不调模型。",
  alternates: { canonical: "/verify" },
  openGraph: {
    title: "行程体检 — 任何 AI 行程先过一遍",
    description:
      "开放标准 Trip Check v0.1：结构自洽性与事实核验两轴分开，结论带可复算凭据。同一份输入，任何人都能复算出同一个 ID。",
    type: "article",
    siteName: "行程规划师",
  },
};

const AXES = [
  {
    title: "结构自洽性",
    tag: "A–D + 0–100 分",
    text: "只靠文档自身判断：时间重叠、路段接不上、节奏超限、预算超支、重复点位。这一轴给等级与分数。",
  },
  {
    title: "事实核验",
    tag: "覆盖率 + 三态",
    text: "看文档声明的来源：地点是否真实存在、营业时间是否对得上、路段有没有真实耗时。不折成分数，只报「查了多少、谁查的、哪一步不知道」。",
  },
  {
    title: "可复算凭据",
    tag: "确定性哈希",
    text: "同一文档 + 同一口径 + 同一引擎/规则版本 → 同一凭据 ID，任何一方都能重跑核对。它不是签名，也不构成对真实世界的背书。",
  },
] as const;

const LIMITS = [
  "不核验事实本身：地点/营业时间/路段的真实性取决于文档声明的来源（provenance）；引擎只判定「按给定事实，行程是否自洽可行」。",
  "不自动改行程：fixHint 只给修复方向，改不改由你决定。",
  "不判断价格是否合理、不预估排队、不覆盖天气突变与临时限流（这些需要实时供给，不在 v0.1 规则里）。",
  "示例里的营业时间是示意数据，不构成真实营业时间承诺。",
] as const;

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ share?: string | string[] }>;
}) {
  const { share } = await searchParams;
  const initialShareId = typeof share === "string" && share.trim() ? share.trim() : undefined;

  return (
    <main className="tc-page at-verify-page">
      <div className="container tc-inner">
        <header className="tc-hero">
          <p className="about-eyebrow">
            <span className="eyebrow-dot" aria-hidden="true" />
            开放标准 · Trip Check v0.1
          </p>
          <h1 className="tc-title">任何 AI 行程，先过一遍体检</h1>
          <p className="tc-lede">
            把一份行程 JSON 交给同一套确定性规则引擎，拿到两轴结论：<b>结构自洽性</b>
            （时间轴/节奏/预算）与<b>事实核验</b>（地点/营业时间/路段，谁核的、核到哪一步）。
            不调模型、不用登录——同一份输入，任何人都能复算出同一个结论和同一张凭据。
          </p>
          <p className="tc-version-line">
            规范 <code className="tc-mono">{TRIP_CHECK_SPEC_VERSION}</code> · 引擎{" "}
            <code className="tc-mono">{TRIP_CHECK_ENGINE_VERSION}</code> · 规则集{" "}
            <code className="tc-mono">{TRIP_CHECK_RULESET_VERSION}</code>
            <span className="tc-version-sep" aria-hidden="true">
              ·
            </span>
            <a href="/api/verify/schema" target="_blank" rel="noreferrer">
              JSON Schema
            </a>
            <span className="tc-version-sep" aria-hidden="true">
              ·
            </span>
            <a href="/api/verify" target="_blank" rel="noreferrer">
              API 元信息
            </a>
          </p>
        </header>

        <TripCheckPlayground key={initialShareId ?? "fresh"} initialShareId={initialShareId} />

        <section className="tc-explainer" aria-labelledby="tc-explainer-title">
          <h2 className="tc-section-title" id="tc-explainer-title">
            为什么是两轴，而不是一个总分
          </h2>
          <p className="tc-section-lede">
            一份行程可能结构完美但事实全没核，也可能结构有硬伤但事实都真。把两者混成一个数字，
            就是用确定性掩盖不确定性。
          </p>
          <ul className="tc-axis-cards">
            {AXES.map((axis) => (
              <li key={axis.title} className="tc-axis-card">
                <div className="tc-axis-card-head">
                  <h3>{axis.title}</h3>
                  <span className="tc-axis-card-tag">{axis.tag}</span>
                </div>
                <p>{axis.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="tc-limits" aria-labelledby="tc-limits-title">
          <h2 className="tc-section-title" id="tc-limits-title">
            这个体检明确不做什么
          </h2>
          <ul className="tc-limits-list">
            {LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
          <p className="tc-limits-foot">
            完整规则清单、错误码与凭据口径见{" "}
            <a href="/api/verify/schema" target="_blank" rel="noreferrer">
              机器契约
            </a>
            ；判定引擎是纯函数（Apache-2.0 参考实现），质疑规则比相信分数更有用。
          </p>
        </section>

        <section className="tc-cta" aria-labelledby="tc-cta-title">
          <div>
            <h2 className="tc-cta-title" id="tc-cta-title">
              想要一份天生可执行的行程？
            </h2>
            <p>先取真实世界的 POI / 营业时间 / 通勤，再让模型在已核验的清单上排。</p>
          </div>
          <Link href="/new" className="btn btn-primary" prefetch={false}>
            用真实事实生成一份 →
          </Link>
        </section>
      </div>
    </main>
  );
}
