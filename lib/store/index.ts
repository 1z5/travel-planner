import "server-only";
import { memoryStore } from "./memory";
import { postgresStore } from "./postgres";
import type { Store } from "./types";

export type { Store, JobRecord, QuotaRecord, CodeRecord } from "./types";

/**
 * 存储门面：DATA_STORE=memory（默认）| postgres。
 * 两个实现共享同一套契约测试；postgres 模块被 import 不会建连接
 * （PrismaClient 懒实例化），memory 路径零数据库依赖。
 */
export function getStore(): Store {
  const kind = process.env.DATA_STORE || "memory";
  return kind === "postgres" ? postgresStore : memoryStore;
}
