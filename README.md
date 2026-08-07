# Open Chat Interface (OCI)

A self-hostable, multi-model chat application with local, OIDC, and SAML
authentication and a first-class administration dashboard.

## Stack

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Frontend | Vite, React 19, TypeScript, Tailwind 4, TanStack Router/Query |
| Backend | Hono on Node 22, AI SDK v7 |
| Auth | Better Auth (email/password, OIDC, SAML 2.0, admin roles) |
| Database | PostgreSQL 17 + Drizzle ORM |
| Cache/Jobs | Redis |
| Tooling | Biome, Vitest, Playwright |

The frontend is a pure SPA: all business logic lives in `apps/api`. In both
development and production the API is reached same-origin through a proxy, so
session cookies need no CORS or `SameSite=None` handling.

## Layout

```
apps/
  api/        Hono API: auth, chat streaming, admin, files
  web/        Vite SPA: chat, settings, admin dashboard
packages/
  shared/     Zod schemas and types shared across the wire
  db/         Drizzle schema, migrations, seeds
  config/     Shared tsconfig presets
docker/       Dockerfiles, Caddy config, compose files
```

## Local development

Requires Node 22+, pnpm 11+, and Docker.

```bash
pnpm install
cp .env.example .env          # then edit the secrets
pnpm infra:up                 # Postgres + Redis
pnpm db:migrate
pnpm db:seed
pnpm dev
```

- Web: <http://localhost:5173>
- API: <http://localhost:3080>

The first administrator is created from `INITIAL_ADMIN_EMAIL` /
`INITIAL_ADMIN_PASSWORD` on an empty database. If no password is supplied a
one-time password is printed to the API logs.

Locked out? `pnpm --filter @oci/api admin:promote you@example.com`.

## Production

```bash
cd docker
docker compose up -d --build
```

Optional profiles: `--profile s3` (MinIO), `--profile search` (SearXNG).

Required environment: `POSTGRES_PASSWORD`, `AUTH_SECRET`, `ENCRYPTION_KEY`,
`APP_URL`. Generate secrets with `openssl rand -base64 48`.

> `ENCRYPTION_KEY` encrypts provider credentials at rest. Rotating it
> invalidates every stored credential.

## Configuration model

Almost nothing is configured through environment variables. Providers, models,
quotas, SSO providers, storage, search, SMTP, and branding are all managed in
the admin dashboard and stored in the database.

Environment variables cover only what must exist before the database can be
read: connection strings, secrets, and the initial administrator.

## Scripts

| Command | Description |
|---|---|
| `pnpm dev` | Run web and API in watch mode |
| `pnpm build` | Build all packages |
| `pnpm lint` / `pnpm lint:fix` | Biome check |
| `pnpm typecheck` | TypeScript across the workspace |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed defaults |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop local Postgres and Redis |

## Licence

MIT
