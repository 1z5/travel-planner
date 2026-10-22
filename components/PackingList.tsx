import { Backpack } from "lucide-react";
import type { Plan } from "@/lib/types";
import { derivePackingList, PACKING_NO_WEATHER_NOTE } from "@/lib/packing";

// 出发前准备卡：由 lib/packing.ts 的确定性规则推导（不调模型）。
//
// 三条展示原则：
// 1. 每项都展示「依据 + 来源」——用户能看懂为什么带；
// 2. 没有依据就不出现——推导为空时如实说明，不塞通用清单；
// 3. 天气未知时明确降级（不编造雨具建议）。
export function PackingList({ plan }: { plan: Plan }) {
  const items = derivePackingList(plan);

  return (
    <section className="card packing-card" aria-labelledby="packing-title">
      <div className="card-body">
        <div className="packing-head">
          <h2 className="packing-title" id="packing-title">
            <Backpack size={16} />
            出发前准备
          </h2>
          <span className="packing-meta">按这份行程推导 · 非通用清单</span>
        </div>

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
    </section>
  );
}
