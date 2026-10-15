# syntax=docker/dockerfile:1

# ---------- 依赖层（lock 不变则命中缓存） ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 构建层 ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 注意：.env 被 .dockerignore 排除，密钥通过运行时环境变量注入
# Prisma 7 起 @prisma/client 没有 postinstall，client 生成必须显式执行；
# 否则 .prisma/client 缺失，DATA_STORE=postgres 路径一跑就崩。
# generate 只读 schema 不连库，无需 DATABASE_URL。
RUN npx prisma generate \
  && npm run build

# ---------- 运行层（standalone 产物，~150MB） ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nextjs -u 1001

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
