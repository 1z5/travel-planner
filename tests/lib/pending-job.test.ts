import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingJob,
  loadPendingJob,
  savePendingJob,
  PENDING_JOB_STORAGE_KEY,
  PENDING_JOB_TTL_MS,
} from "@/lib/pending-job";

// 「进行中的任务」本地句柄：生成要 2-7 分钟，用户离开/刷新后要能续上轮询。
// 这里守住四类真实故障：没存过不恢复、过期不恢复、脏数据不炸、终态能清掉。

function base(over: Partial<Parameters<typeof savePendingJob>[0]> = {}) {
  return { jobId: "job_test_1", createdAt: Date.now(), ...over };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("pending-job", () => {
  it("没存过时返回 null（不伪造任务）", () => {
    expect(loadPendingJob()).toBeNull();
  });

  it("保存后可读回，days 原样保留", () => {
    const job = base({ days: 3 });
    savePendingJob(job);
    expect(loadPendingJob()).toEqual(job);
  });

  it("超过服务端 Job TTL（2 小时）视为过期，并清掉存储", () => {
    const createdAt = Date.now() - PENDING_JOB_TTL_MS - 1000;
    savePendingJob(base({ createdAt }));
    expect(loadPendingJob()).toBeNull();
    expect(window.localStorage.getItem(PENDING_JOB_STORAGE_KEY)).toBeNull();
  });

  it("刚好超过 2 小时的边界：过期（与后端任务 TTL 同口径）", () => {
    const createdAt = Date.now() - PENDING_JOB_TTL_MS - 1;
    savePendingJob(base({ createdAt }));
    expect(loadPendingJob()).toBeNull();
  });

  it("损坏的 JSON 不抛错，降级为 null 并清理", () => {
    window.localStorage.setItem(PENDING_JOB_STORAGE_KEY, "{not json");
    expect(loadPendingJob()).toBeNull();
    expect(window.localStorage.getItem(PENDING_JOB_STORAGE_KEY)).toBeNull();
  });

  it("字段非法（jobId 空 / createdAt 非正数 / days 越界）一律当脏数据丢弃", () => {
    for (const bad of [
      { jobId: "", createdAt: Date.now() },
      { jobId: "job_x", createdAt: 0 },
      { jobId: "job_x", createdAt: "now" },
      { jobId: "job_x", createdAt: Date.now(), days: 0 },
      { jobId: "job_x", createdAt: Date.now(), days: 1.5 },
    ]) {
      window.localStorage.setItem(PENDING_JOB_STORAGE_KEY, JSON.stringify(bad));
      expect(loadPendingJob()).toBeNull();
    }
  });

  it("clear 后读不到", () => {
    savePendingJob(base());
    clearPendingJob();
    expect(loadPendingJob()).toBeNull();
  });

  it("localStorage 写失败（隐私模式）时不抛错，读回 null", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      expect(() => savePendingJob(base())).not.toThrow();
      expect(loadPendingJob()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
