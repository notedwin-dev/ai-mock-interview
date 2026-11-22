FROM node:22-alpine AS base
RUN corepack enable

# Dependencies are installed without lifecycle scripts: the app's postinstall
# runs `prisma generate`, which needs the schema that only exists in the builder stage.
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM base AS builder
WORKDIR /app
ENV BUILD_STANDALONE=1
# `next build` evaluates route modules, and the database client module parses
# DATABASE_URL at import time. No connection is made during the build, so a
# syntactically valid placeholder is enough — never a real credential. The
# runner stage receives the real DATABASE_URL from the environment
# (docker-compose app service).
ARG BUILD_DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build
ENV DATABASE_URL=$BUILD_DATABASE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma generate && pnpm exec next build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Recordings are held here and expire after 24h; see README.
RUN mkdir -p /app/storage/recordings && chown -R nextjs:nodejs /app/storage

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
