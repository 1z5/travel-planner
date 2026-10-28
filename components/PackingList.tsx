import { Backpack, ChevronDown } from "lucide-react";
import type { Plan } from "@/lib/types";
import { derivePackingList, PACKING_NO_WEATHER_NOTE } from "@/lib/packing";

// 出发前准备卡：由 lib/packing.ts 的确定性规则推导（不调模型）。
//
// 三条展示原则：
// 1. 每项都展示「依据 + 来源」——用户能看懂为什么带；
// 2. 没有依据就不出现——推导为空时如实说明，不塞通用清单；
// 3. 天气未知时明确降级（不编造雨具建议）。
//
// 为什么默认折叠（2026-10 用户反馈）：准备清单在 500px 宽下占 600–1000px，
// 但它是「出发前才需要」的信息，不该在浏览行程时把页面拉得更长。折叠只影响
// 页面长度，不减少信息量：summary 显示条数，展开后每项依据/来源原样保留。
export function PackingList({ plan }: { plan: Plan }) {
  const items = derivePackingList(plan);

  return (
    <section className="card packing-card" id="plan-packing" aria-labelledby="packing-title">
      <details className="packing-details">
        <summary className="packing-summary">
          <span className="packing-title" id="packing-title">
            <Backpack size={16} aria-hidden="true" />
            出发前准备
          </span>
          <span className="packing-summary-meta">
            {items.length > 0 ? `· ${items.length} 项` : "· 无特定准备项"}（展开查看）
          </span>
          <ChevronDown className="packing-chevron" size={16} aria-hidden="true" />
        </summary>

        <div className="packing-body">
          <p className="packing-meta">按这份行程推导 · 非通用清单</p>

          {items.length > 0 ? (
            <ul className="packing-list">
              {items.map((it) => (
                <li key={it.label} className={`packing-item packing-item-${it.group}`}>
                  <div className="packing-item-main">
                    <span className="packing-label">{it.label}</span>
                    <span className="packing-reason">{it.reason}</span>
                  </div>
                  <span className="packing-source">{it.source}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted packing-empty">
              这份行程没有推导出特定的准备项——我们不会用「换洗内衣、充电器」这类通用条目凑数。
            </p>
          )}

          <p className="packing-degrade">{PACKING_NO_WEATHER_NOTE}</p>
        </div>
      </details>
    </section>
  );
}
