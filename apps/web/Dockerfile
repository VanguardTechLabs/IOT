FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
# Every workspace manifest has to be present for pnpm to validate the lockfile,
# even though only @pulse/web is installed and built here.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/ingest/package.json apps/ingest/
COPY apps/simulator/package.json apps/simulator/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@pulse/web"
COPY apps/web ./apps/web
RUN pnpm --filter @pulse/web build

# Caddy serves the built SPA and reverse-proxies the API on the same origin.
FROM caddy:2-alpine AS runtime
COPY --from=build /app/apps/web/dist /srv
COPY infra/caddy/Caddyfile /etc/caddy/Caddyfile
