# 行程生成对照评测

`npm run eval:cases` 通过生成和状态 API，记录同一任务中第一份有站点的计划与终稿。首份可以是快速初版、已完成部分天数的计划，或轮询首次看到的终稿。占位草稿和空大纲不计入首份。耗时从提交到收到快照，受轮询间隔和机器负载影响。

明细写入 `eval-results/generation-*.json`，包括实际提交日期、已显示天数、预算使用比例、首末日时间窗越界、Trip Check 结构分和规则编号，以及地点、开放时间和真实路段覆盖。预算比例按当前可见站点计算，分日过程中只代表已经显示的部分。

## 使用本地桩复跑

先在独立终端启动模型桩和地图桩。

```bash
STUB_DAY_DELAY_MS=1500 node scripts/stub-llm.mjs 8918
```

```bash
node scripts/amap-stub.mjs 8919
```

用独立构建目录启动应用。端口被占用时可同步修改命令中的地址。

```bash
NEXT_DIST_DIR=.next-eval-comparison DATA_STORE=memory LOCAL_TRIPS_ONLY=1 \
  ENABLE_ONLINE_GENERATION=1 ENABLE_ONLINE_MAP=1 AUTH_PROVIDER=none DAILY_FREE_LIMIT=50 \
  LLM_BASE_URL=http://127.0.0.1:8918/v1 LLM_API_KEY=stub-key LLM_MODEL=step-5-preview \
  AMAP_BASE_URL=http://127.0.0.1:8919 AMAP_WEB_SERVICE_KEY=stub-amap-key \
  node node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 3181 \
  > /tmp/travel-generation-eval.log 2>&1
```

应用启动后，在另一终端预热 API 并运行。

```bash
curl -s -o /dev/null -H 'Content-Type: application/json' --data '{}' http://127.0.0.1:3181/api/plan
curl -s -o /dev/null http://127.0.0.1:3181/api/plan/status
EVAL_BASE=http://127.0.0.1:3181 EVAL_SOURCE=stub EVAL_SUITE=comparison \
  EVAL_CONCURRENCY=1 EVAL_POLL_MS=200 EVAL_SERVER_LOG=/tmp/travel-generation-eval.log \
  npm run eval:cases
```

`EVAL_SUITE=regional` 是默认跨城市用例，可用 `EVAL_CASES` 限制数量。接入真实服务前确认模型和地图额度。采集日志时保持评测独占服务且并发为 1。首份的 usage 是收到快照时已经写入日志的累计值，`null` 表示没有观察到用量。失败请求的用量也可能没有记录。

## 2026-11-19 本地桩基线

三组样本均从 2026-11-20 开始。地图和模型都使用本地桩，长行程的每次分日请求有 1.5 秒人工延迟。下表用于对照交付阶段和检出问题。耗时与 token 只反映这个本地环境。

| 苏州样本     | 首份耗时及天数 | 终稿耗时及天数 | 站点花费占预算 | 首份 / 终稿结构阻断 | 终稿桩用量 |
| ------------ | -------------- | -------------- | -------------- | ------------------- | ---------- |
| 3 天，¥2,500 | 68 ms · 3/3    | 282 ms · 3/3   | 28% → 77%      | 0 / 4               | 3,104      |
| 5 天，¥4,500 | 1,725 ms · 3/5 | 3,185 ms · 5/5 | 43% → 55%      | 4 / 6               | 4,947      |
| 3 天，¥650   | 35 ms · 3/3    | 241 ms · 3/3   | 109% → 296%    | 0 / 4               | 3,104      |

两份 3 天初版的开放时间和真实路段覆盖均为零。终稿补入路线资料后检出了前后站时间接不上的问题（`TC-C103`）。三个样本的首份与终稿都有首末日时间窗越界。对比下一种规划策略时，优先检查窗口、预算和路段间隔，再看覆盖与耗时。

### 快速初版约束修复后复跑

沿用同一批本地桩输入。¥2,500 三天样本的快速初版从 28% 降至预算的 26%，¥650 三天样本从 109% 降至 87%（¥565），两份初版的时间窗越界都从 2 处降至 0。五天样本的首份可用计划仍是模型生成的分日快照，仍有 1 处越界。紧预算终稿仍为 296%，模型精排的约束需要另行处理。

### 模型生成时间窗与预算纠正复跑

三份终稿和五天首份分日快照的时间窗越界均从 1 处降至 0。¥650 样本触发一次预算纠正，模型桩仍返回同样的超支方案，终稿继续标出超预算。运行报告中的桩用量从一次请求的 3,104 增至两次请求的 6,208。
