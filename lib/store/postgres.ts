import "server-only";
import type { Plan, PlanInput } from "../types";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { CodeRecord, JobRecord, PlanRecord, QuotaRecord, Store } from "./types";

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
// 行程（Plan）不做 TTL 清理：它是用户的产品资产（分享链接/继续编辑的落点），
// 不像任务那样是一次性执行记录。单份行程 JSON 约 10-25KB，即使每天 100 份、
// 一年也只有 ~0.9GB——持久保存的收益（链接不会忽然失效）远大于这点存储成本。
// 需要清理时由运维按业务规则单独处理（例如「用户主动删除」功能），
// 不在全局 sweep 里按时间静默删用户资产。

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
        shareId: record.shareId,
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
      shareId: row.shareId ?? undefined,
      // updatedAt 是列上的心跳：status 路由靠它识别服务重启留下的僵尸任务
      updatedAt: row.updatedAt.getTime(),
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
        ...(patch.shareId !== undefined ? { shareId: patch.shareId } : {}),
        // 显式写 updatedAt：空 patch（纯心跳）也必须让 @updatedAt 刷新，
        // 否则「每次 update 都是一次心跳」的契约在 PG 实现上不成立
        updatedAt: new Date(patch.updatedAt ?? Date.now()),
      },
    });
  },
};

function mapPlanRecord(row: {
  id: string;
  jobId: string | null;
  ownerKey: string | null;
  plan: Prisma.JsonValue;
  input: Prisma.JsonValue;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}): PlanRecord {
  return {
    id: row.id,
    jobId: row.jobId ?? undefined,
    ownerKey: row.ownerKey ?? undefined,
    plan: row.plan as unknown as Plan,
    input: row.input as unknown as PlanInput,
    revision: row.revision,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

const planStore = {
  async save(record: PlanRecord) {
    const data = {
      jobId: record.jobId,
      ownerKey: record.ownerKey,
      plan: record.plan as unknown as Prisma.InputJsonValue,
      input: record.input as unknown as Prisma.InputJsonValue,
      revision: record.revision,
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    };
    // upsert：commitPlan 判重靠 JobRecord.shareId，但进程在「存了 Plan、还没回写
    // shareId」之间崩溃后重放时，同 id 覆盖比 create 冲突更能自愈
    await prisma().plan.upsert({
      where: { id: record.id },
      create: { id: record.id, ...data },
      update: data,
    });
  },
  async get(id: string) {
    const row = await prisma().plan.findUnique({ where: { id } });
    return row ? mapPlanRecord(row) : null;
  },
  async replace(id: string, plan: Plan) {
    try {
      // revision 自增交给数据库（原子），避免「读-改-写」在并发改行程时丢更新
      const row = await prisma().plan.update({
        where: { id },
        data: {
          plan: plan as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      return mapPlanRecord(row);
    } catch (e) {
      // P2025 = 目标记录不存在：映射为 null（业务分支），其余错误照常抛出
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025") return null;
      throw e;
    }
  },
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const quotaStore = {
  async consume(key: string, limit: number) {
    const t = today();
    // 跨天清零：date 不是今天就把计数重置为 0。
    // 踩过的 P0：旧实现只 upsert +1 并把 date 改成今天，跨天后 count 继续累加，
    // 「每日 3 次」在 Postgres 上变成永久 3 次（memory 实现整桶替换，所以单测
    // 与 memory e2e 全绿，只有生产走 Postgres 才踩中）。
    // 先 updateMany 再 upsert：PG 的 UPDATE 会等行锁并重新求值 WHERE，
    // 并发请求只会重置一次，不会把别人的自增覆盖回 0；无行时 updateMany 是 no-op。
    await prisma().quotaBucket.updateMany({
      where: { key, date: { not: t } },
      data: { date: t, count: 0 },
    });
    // 原子自增：不存在则创建（upsert），存在则 +1
    const row = await prisma().quotaBucket.upsert({
      where: { key },
      create: { key, date: t, count: 1 },
      update: { count: { increment: 1 } },
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
    // 注意：plan 表不在这里清理（见文件顶部注释：行程是资产，不按时间删）
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export const postgresStore: Store = {
  jobs: jobStore,
  plans: planStore,
  quota: quotaStore,
  codes: codeStore,
};
export { sweep };
