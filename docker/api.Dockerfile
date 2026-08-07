FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @oci/api...

FROM deps AS build
COPY packages ./packages
COPY apps/api ./apps/api
RUN pnpm --filter @oci/api... build

FROM base AS runtime
ARG OCI_VERSION=dev
ARG OCI_REVISION=unknown
ARG OCI_SOURCE=https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface
ARG OCI_CREATED=unknown
ENV NODE_ENV=production
ENV OCI_VERSION=$OCI_VERSION
LABEL org.opencontainers.image.title="Open Chat Interface API" \
      org.opencontainers.image.description="API service for Open Chat Interface" \
      org.opencontainers.image.version=$OCI_VERSION \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.created=$OCI_CREATED \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY LICENSE /licenses/LICENSE

RUN addgroup -S oci && adduser -S oci -G oci && mkdir -p /data/storage && chown -R oci:oci /data
USER oci

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api
CMD ["node", "dist/server.js"]
