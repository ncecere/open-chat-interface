FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY apps/web/package.json ./apps/web/
COPY packages/config/package.json ./packages/config/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @oci/web...

COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm --filter @oci/web... build

FROM caddy:2-alpine AS runtime
ARG OCI_VERSION=dev
ARG OCI_REVISION=unknown
ARG OCI_SOURCE=https://github.com/ncecere/open-chat-interface
ARG OCI_CREATED=unknown
LABEL org.opencontainers.image.title="Open Chat Interface Web" \
      org.opencontainers.image.description="Web application and same-origin proxy for Open Chat Interface" \
      org.opencontainers.image.version=$OCI_VERSION \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.url=$OCI_SOURCE \
      org.opencontainers.image.documentation="${OCI_SOURCE}/blob/main/README.md" \
      org.opencontainers.image.vendor="Open Chat Interface contributors" \
      org.opencontainers.image.created=$OCI_CREATED \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /app/apps/web/dist /srv
COPY docker/Caddyfile /etc/caddy/Caddyfile
COPY LICENSE /licenses/LICENSE
EXPOSE 8080
