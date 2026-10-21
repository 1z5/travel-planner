// 切片 e2e · 占位模块（由负责该切片的队友填充断言）
//
// 契约：导出 `export async function runSlice(ctx)`，ctx = { check, api, mode }
//   - check(name, cond, detail?)：断言（与 orchestrator 共用计数）
//   - api：makeApi 实例——api.baseUrl / api.post(payload) / api.postRaw(text) /
//     api.waitJob(jobId, timeoutMs) / api.authPost(path, payload) / api.me()
//   - mode："mock"（3103，无高德 key）| "real"（3104，高德桩）
// 每个模块在 mock 与 real 两台服务器上各跑一遍——必须幂等、自行判断模式适用性。
export async function runSlice() {
  // TODO(队友)：填充本切片的 e2e 断言
}
