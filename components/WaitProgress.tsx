// 生成等待期的进度可视化。产品一次生成等 3-5 分钟（跨境更久），干等最容易
// 让人以为卡死——给一个视觉进度反馈。
//
// 诚实原则：只有拿到确切进度（流式路径的真实 N/M 天）才画确定性宽度；拿不到
// 增量数据时（单次路径）画不确定动画条，不假装百分比。与项目「不知道就不猜」
// 一贯立场一致。

export function WaitProgress({
  pct,
  elapsed,
  detail,
}: {
  pct: number | null;   // 0-100 的确定进度；null = 不确定（动画）
  elapsed: string;      // 已等待时长，如 "2:30"
  detail?: string;      // 额外说明，如 "已生成 3/5 天"
}) {
  return (
    <div className="wait-progress">
      <div
        className="wait-bar"
        role="progressbar"
        aria-label="生成进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <div
          className={`wait-bar-fill${pct === null ? " indeterminate" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%` }}
        />
      </div>
      <div className="wait-meta">
        <span>已等待 {elapsed}</span>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}
