import { defineConfig } from "prisma/config";

// Prisma 7 起 schema.prisma 不再携带连接串，CLI（migrate / db push / validate）
// 的数据库地址移到这里。运行时（lib/store/postgres.ts）则通过 PrismaClient
// 的构造参数传 driver adapter，两条路径都指向同一个 DATABASE_URL。
// 详见 https://pris.ly/d/config-datasource
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
