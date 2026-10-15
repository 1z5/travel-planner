import "server-only";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { CodeRecord, JobRecord, QuotaRecord, Store } from "./types";

// ============================================================
// PostgreSQL 实现（Prisma）。客户端懒实例化——只有 DATA_STORE=
// postgres 时才建连接，memory 路径完全不碰数据库。
// 行为契约与 memory 实现一致（同一套契约测试验证）。
//
// Prisma 7 迁移：schema.prisma 不再携带连接串（见该文件注释），运行时改为
// 显式传 driver adapter；CLI 的连接地址在 prisma.config.ts。两条路径读同一个
// DATABASE_URL，不会漂。
// ============================================================

let client: PrismaClient | null = null;

function prisma(): PrismaClient {
  if (!client) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATA_STORE=postgres 需要配置 DATABASE_URL");
    }
    client = new PrismaClient({ adapter: new PrismaPg(url) });
  }
  return client;
}

const TTL_MS = 2 * 3600_000; // 任务保留 2 小时（同 memory 实现）

const jobStore = {
  async create(record: JobRecord) {
    await prisma().job.create({
      data: {
        id: record.id,
        status: record.status,
        plan: record.plan ? (record.plan as unknown as Prisma.InputJsonValue) : undefined,
        error: record.error,
        key: record.key,
        limit: record.limit,
        createdAt: new Date(record.createdAt),
      },
    });
  },
  async get(id: string) {
    const row = await prisma().job.findUnique({ where: { id } });
    if (!row) return null;
    return {
      id: row.id,
      status: row.status as JobRecord["status"],
      plan: (row.plan as unknown as JobRecord["plan"]) ?? undefined,
      error: row.error ?? undefined,
      key: row.key,
      limit: row.limit,
      createdAt: row.createdAt.getTime(),
    };
  },
  async update(id: string, patch: Partial<JobRecord>) {
    await prisma().job.update({
      where: { id },
      data: {
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.plan !== undefined
          ? { plan: patch.plan ? (patch.plan as unknown as Prisma.InputJsonValue) : Prisma.DbNull }
          : {}),
        ...(patch.error !== undefined ? { error: patch.error } : {}),
      },
    });
  },
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const quotaStore = {
  async consume(key: string, limit: number) {
    const t = today();
    // 原子自增：不存在则创建（upsert），存在则 +1
    const row = await prisma().quotaBucket.upsert({
      where: { key },
      create: { key, date: t, count: 1 },
      update: { count: { increment: 1 }, date: t },
    });
    return { allowed: row.count <= limit, remaining: Math.max(0, limit - row.count) };
  },
  async refund(key: string) {
    await prisma().quotaBucket.updateMany({
      where: { key, date: today(), count: { gt: 0 } },
      data: { count: { decrement: 1 } },
    });
  },
  async peek(key: string, limit: number) {
    const row = await prisma().quotaBucket.findUnique({ where: { key } });
    if (!row || row.date !== today()) return limit;
    return Math.max(0, limit - row.count);
  },
};

const codeStore = {
  async put(record: CodeRecord) {
    await prisma().smsCode.upsert({
      where: { phone: record.phone },
      create: { phone: record.phone, code: record.code, expiresAt: new Date(record.expiresAt) },
      update: { code: record.code, expiresAt: new Date(record.expiresAt) },
    });
  },
  async verify(phone: string, code: string) {
    const row = await prisma().smsCode.findUnique({ where: { phone } });
    if (!row) return false;
    if (row.expiresAt.getTime() < Date.now()) {
      await prisma().smsCode.delete({ where: { phone } });
      return false;
    }
    if (row.code !== code) return false;
    await prisma().smsCode.delete({ where: { phone } }); // 一次性消费
    return true;
  },
};

// 惰性清理过期数据（每次调用 job.get 时顺带，避免长驻进程无限增长）
async function sweep() {
  const cutoff = new Date(Date.now() - TTL_MS);
  try {
    await prisma().job.deleteMany({ where: { createdAt: { lt: cutoff } } });
    await prisma().smsCode.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch { /* 清理失败不影响主流程 */ }
}

export const postgresStore: Store = { jobs: jobStore, quota: quotaStore, codes: codeStore };
export { sweep };
