FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @oci/web...

COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @oci/web... build

FROM caddy:2-alpine AS runtime
COPY --from=build /app/apps/web/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
EXPOSE 8080
