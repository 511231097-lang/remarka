FROM node:22-bookworm-slim AS base

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json

RUN npm ci

COPY . .

# Prisma client is required both for web API routes and worker runtime.
RUN npm run db:generate

FROM base AS web-build
# Bigger heap for Next.js build worker — defaults to ~1.5 GB and SIGTRAPs
# on bundles with our chat/library screen sizes.
ENV NODE_OPTIONS=--max-old-space-size=4096
# NEXT_PUBLIC_* env-переменные должны быть доступны на build-time, чтобы
# Next.js мог их инлайнить в client-bundle'ы. .env.docker копируется в
# apps/web/.env.production — Next.js его автоматически загружает при
# next build. Серверные секреты в .env.production не инлайнятся в бандлы
# (Next инлайнит ТОЛЬКО NEXT_PUBLIC_*), так что это безопасно. Сам файл
# не попадает в финальный web-образ — ниже мы копируем только .next.
RUN if [ -f .env.docker ]; then cp .env.docker apps/web/.env.production; fi
RUN npm run web:build

FROM node:22-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/package.json /app/package-lock.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps ./apps
COPY --from=base /app/packages ./packages
COPY --from=web-build /app/apps/web/.next ./apps/web/.next

EXPOSE 3000

CMD ["npm", "--prefix", "apps/web", "run", "start", "--", "-H", "0.0.0.0", "-p", "3000"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/package.json /app/package-lock.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/apps ./apps
COPY --from=base /app/packages ./packages

# Run worker without --env-file to avoid container-local .env dependency.
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]
