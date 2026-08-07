# Open Chat Interface (OCI)

A self-hostable, multi-model chat application with local, OIDC, and SAML
authentication and a first-class administration dashboard. OCI includes streaming
chat and reasoning, resumable Redis-backed generations, attachments, grounded web
search, personas, branching, temporary chats, and privacy-filtered share links.

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

Self-hosted OIDC/SAML identity providers on private networks must be listed in
`AUTH_TRUSTED_ORIGINS`; otherwise discovery is refused as unroutable.

## Coverage

There is deliberately no repository-wide coverage threshold. Coverage counts
lines executed rather than behaviour verified, so a global percentage mostly
rewards tests written for the metric.

`apps/api/vitest.config.ts` instead sets per-file floors on the modules where a
regression is a security bug rather than a correctness one: authorization,
credential handling, untrusted input validation, quota enforcement, and share
sanitization. Each floor sits just below its measured value, so it catches
erosion without inviting number-chasing.

## Continuous integration

`.gitlab-ci.yml` runs lint, typecheck, and a production dependency audit, then
the mock and live test suites, then builds both container images.

Live tests get Postgres, MinIO, and Mailpit as GitLab services, so CI exercises
real migrations and storage rather than only mocks. Images build on every
pipeline as a check but are published to the project registry only from the
default branch and tags.

## Live integration tests

`pnpm test` runs entirely against mocks, so it needs no services. `pnpm
test:live` additionally exercises real infrastructure:

```bash
pnpm infra:up                                          # Postgres
docker compose -f docker/compose.auth-test.yaml up -d  # MinIO, Mailpit, Keycloak
pnpm test:live
```

Each suite skips rather than fails when its dependency is unreachable, so a
partial stack still produces a green run. Postgres tests create a throwaway
database, apply the committed migrations, and drop it afterwards, so
development data is never touched.

These cover what mocks cannot: that migrations apply cleanly, that constraints
and cascades actually fire, that the S3 driver round-trips bytes, and that
invite tokens really do travel in the URL fragment.

## Testing SSO and email locally

`docker/compose.auth-test.yaml` starts a preconfigured Keycloak realm (OIDC and
SAML clients, one test user) plus Mailpit for capturing outbound mail.

```bash
docker compose -f docker/compose.auth-test.yaml up -d
```

- Keycloak: <http://localhost:8090> · realm `oci-test` · user `oci-test-user` / `OciTestPass123!`
- Mailpit UI: <http://localhost:8025> · SMTP on `localhost:1025`

Run the API with `AUTH_TRUSTED_ORIGINS=http://localhost:8090`, then register the
providers in **Admin → Auth & SSO** using provider IDs `oci-oidc` and `oci-saml`
so the callback URLs match the imported realm. The credentials in this realm are
test-only and must never be reused.

### Account linking

When two providers assert the same email, the second sign-in is refused unless
that provider is marked **Trust for account linking**. The toggle is off by
default and, once enabled, linking still requires the email domain to match the
provider's allowed domains.

Enable it only for an identity provider that genuinely verifies email
ownership. One that does not could assert an existing user's address and take
over the account.

> `ENCRYPTION_KEY` encrypts provider credentials at rest. Rotating it
> invalidates every stored credential.

## Theming

Surfaces use the shadcn **neutral** palette (Tailwind `neutral`, zero chroma) in
OKLCH. Layered on top is an accent family selected in **Admin → Settings →
General → Appearance**: `neutral`, `blue`, `violet`, or `emerald`.

The accent is instance-wide and applied via a `data-color-theme` attribute on
`<html>`, so it reaches the login and public share pages too. Light/dark remains
a per-user choice, and a user's boring mode still overrides the accent locally.

All colors live in `apps/web/src/styles/tokens.css`; components reference CSS
variables only, so adding a family means adding one block there plus an entry in
`COLOR_THEMES`.

## Model labs and logos

Each catalog model can be attributed to the lab that created it, chosen from a
picker in **Admin → Model catalog → Add/Edit model**. The lab supplies a logo
shown beside the model in the picker and the admin catalog, with separate
light and dark marks selected from the active theme.

The catalog lives in `packages/shared/src/model-labs.ts` and the SVGs in
`apps/web/public/logos/`. Both are generated from the
[LobeHub icon set](https://github.com/lobehub/lobe-icons) (MIT):

```bash
pnpm logos:sync   # requires the s3cmd CLI
```

The sync copies only the base mark per vendor, verifies every file against the
bucket manifest's SHA-256, and rewrites the catalog. Curated display names live
in `scripts/lab-names.json` so a resync never clobbers capitalization such as
`NVIDIA` or `xAI`. Company logos may be governed by their owners' trademark and
brand-use policies; the upstream MIT license ships alongside the assets.

## Quota policies

Limits are named policies applied to roles, managed in **Admin → Quotas & limits**.
A role can carry several policies at once and every one is enforced.

- **Measure**: messages, tokens, or budget in dollars.
- **Window**: rolling over N hours, or calendar-based (daily, weekly, monthly)
  resetting at midnight in a chosen IANA timezone.

Budget policies need per-model prices, set in the model catalog as dollars per
million input and output tokens. Money is stored as integer micro-dollars, and
prices are snapshotted onto each usage event so later catalog edits never
rewrite historical spend. Models left unpriced contribute zero cost.

Enforcement reserves the run before generation and settles it afterwards, so
concurrent requests are visible to each other and cannot collectively overshoot
a limit. Cancelled and failed runs still settle, which keeps a message quota
meaningful for someone who repeatedly stops mid-generation. A reservation
abandoned by a crashed process stops counting after 15 minutes and is swept.

> Cost tracking depends on the provider reporting token usage. OCI requests it
> explicitly, which OpenAI-compatible gateways such as LiteLLM only return when
> asked. A provider that still omits usage records zero tokens, so budget
> policies cannot bill it.

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
| `pnpm test` | Vitest unit and integration suites |
| `pnpm test:live` | Integration tests against real Postgres, S3, and SMTP |
| `pnpm test:coverage` | Test run with per-file coverage floors enforced |
| `pnpm test:e2e` | Playwright desktop/mobile smoke suite against a running app |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` / `pnpm db:seed` | Apply migrations / seed defaults |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop local Postgres and Redis |

## Licence

MIT
