# Open Chat Interface (OCI)

A self-hostable, multi-model chat application with local, OIDC, and SAML
authentication and a first-class administration dashboard. OCI includes streaming
chat and reasoning, resumable Redis-backed generations, attachments, grounded web
search, branching, temporary chats, and privacy-filtered share links.

[Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) · [Security policy](SECURITY.md) ·
**[Documentation](docs/README.md)** — [using it](docs/user/README.md) ·
[running it](docs/admin/README.md) · [working on it](docs/dev/README.md)

[Contributing](CONTRIBUTING.md) · [Release process](docs/RELEASING.md) ·
[Production operations](docs/OPERATIONS.md)

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

The primary repository is [ncecere/open-chat-interface on GitHub](https://github.com/ncecere/open-chat-interface).
Requires Node 22+, pnpm 11.18.0 (the pinned package manager), and Docker.

```bash
git clone git@github.com:ncecere/open-chat-interface.git
cd open-chat-interface
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
`INITIAL_ADMIN_PASSWORD` on an empty database. If no password is supplied (the
variable is unset or empty) a one-time password is printed to the API logs.

Locked out? `pnpm --filter @oci/api admin:promote you@example.com`.

## Production

### Build from source

```bash
cd docker
docker compose up -d --build
```

### Deploy a released version

Release deployments should pin both application images to the same immutable
version instead of tracking `latest`. The commands below are for a fresh
installation; existing instances must follow the drained upgrade procedure in
[Production operations](docs/OPERATIONS.md) before starting new API producers:

```bash
export OCI_VERSION=v0.9.2
export OCI_REGISTRY=ghcr.io/ncecere/open-chat-interface
export OCI_API_IMAGE="$OCI_REGISTRY/api:$OCI_VERSION"
export OCI_WEB_IMAGE="$OCI_REGISTRY/web:$OCI_VERSION"
# GHCR_READ_TOKEN must come from your secret manager, not a committed file.
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u ncecere --password-stdin
cd docker
docker compose pull api web migrate
docker compose up -d --no-build
```

The repository is private. Keep both GHCR packages private and verify their
visibility after publication: package visibility is independent of repository
visibility. Private pulls require a personal access token (classic) with
`read:packages` and access to the repository/packages; never commit it. Published images target `linux/amd64` only. Unset `OCI_API_IMAGE` and
`OCI_WEB_IMAGE` to retain Compose's local source-build defaults.

Confirm publication succeeded for the selected version before pulling it.
[Release process](docs/RELEASING.md) also documents manual publication of the
historical `v0.4.1` tag without moving it.

Optional profiles: `--profile s3` (MinIO), `--profile search` (SearXNG).

Required environment: `POSTGRES_PASSWORD`, `AUTH_SECRET`, `ENCRYPTION_KEY`,
`APP_URL`. Generate secrets with `openssl rand -base64 48`. See
[Production operations](docs/OPERATIONS.md) for backups, upgrades, health
verification, and rollback constraints.

The API applies migrations and seeds default settings on boot, so a fresh stack
comes up without a separate migration step. Both operations are idempotent and
an existing deployment passes straight through.

Set `INITIAL_ADMIN_EMAIL` to create the first administrator. Leaving
`INITIAL_ADMIN_PASSWORD` unset (or empty, as in `.env.example`) prints a
one-time password to the API logs (`docker compose logs api`) instead of baking
a credential into the environment.

Once running, sign in and open **Admin**. The setup checklist on **Overview**
lists what is still missing, in order, and links to each page. Start by adding a
provider and enabling models under **Admin → Models → Providers & Models**, where
the default model is also chosen. No model is available to users until an
administrator enables one.

### Running more than one API replica

Startup migrations are guarded by a Postgres advisory lock, so replicas can boot
together safely. For a predictable rollout, give schema changes their own job
instead:

```bash
docker compose run --rm migrate                       # once, before rollout
RUN_MIGRATIONS=false docker compose up -d --no-build --scale api=3
```

A replica started with `RUN_MIGRATIONS=false` against a database with no schema
refuses to start rather than failing later on an arbitrary query.

Caddy re-resolves the API service name, so replicas are discovered as they
scale. Sessions are cookie-signed and stream resume goes through Redis, so no
sticky sessions are needed.

Two constraints to know before scaling:

- **Object storage is required.** The local filesystem driver writes to a
  per-container volume, so an attachment uploaded through one replica is
  invisible to the others unless every replica shares one host volume.
  Configure S3 under **Admin → Data & storage → Storage**.
- **Role and ban changes lag.** Sessions are cached for up to five minutes per
  replica, so a revoked session may remain usable on other replicas until that
  cache expires.

Self-hosted OIDC/SAML identity providers on private networks must be listed in
`AUTH_TRUSTED_ORIGINS`; otherwise discovery is refused as unroutable.

## Accessibility

The interface targets **WCAG 2.2 Level AA**. `pnpm test:e2e` runs an axe scan
tagged for 2.2 AA across the sign-in, chat, settings, admin, share, and dialog
surfaces, on desktop and mobile viewports.

Automation covers roughly a third of the success criteria, so the suite also
encodes checks from a manual keyboard pass: a skip link as the first tab stop,
a visible focus indicator on every control reached by Tab, and dialogs that
return focus to whatever opened them.

Colour choices are constrained by contrast rather than taste. Destructive
buttons use a dedicated `--danger-solid` fill because the lighter `--danger`,
which has to stay readable as text on dark surfaces, only reaches 3.5:1 behind
white.

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

GitHub Actions validates pull requests and `main` with read-only permissions,
using Node 22 and pnpm 11.18.0. Checks cover lint, type checking, builds,
unit/integration tests, API coverage floors, live PostgreSQL/Redis/Mailpit and
browser tests, production dependency auditing, and license policy. S3-dependent
live tests can skip when S3 is unavailable; a green run does not establish S3
coverage. GitLab SAST and dependency-scanning report parity is not provided.

**Publish containers** runs for stable `vX.Y.Z` tag pushes or a manual dispatch
for an existing stable tag. It checks `main` ancestry, package versions, and the
changelog, then validates the checked-out tagged source before publishing API
and web images to GHCR. PR and `main` validation never publish images. Publishing
uses `GITHUB_TOKEN` with `packages:write`, not a stored PAT. See the
[release process](docs/RELEASING.md) for tags, retries, and `latest` promotion.

`.gitlab-ci.yml` remains as legacy configuration only. Existing GitLab releases,
images, and history remain hosted there; their historical changelog links are
preserved. GitHub Actions does not create GitHub Releases or import GitLab
release metadata.

## Live integration tests

`pnpm test` runs unit/integration suites, including Redis checks when available.
`pnpm test:live` additionally exercises PostgreSQL, SMTP and S3:

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
providers under **Single sign-on** on **Admin → Sign-in & security →
Authentication** using provider IDs `oci-oidc` and `oci-saml`
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
OKLCH. Layered on top is an accent family selected as **Accent color** in
**Admin → Appearance & features → Branding → Appearance**: `neutral`, `blue`,
`violet`, or `emerald`.

The accent is instance-wide and applied via a `data-color-theme` attribute on
`<html>`, so it reaches the login and public share pages too. Light/dark remains
a per-user choice; **Default theme** on the same page (light, dark, or system)
applies only to people who have not chosen one. A user's boring mode still
overrides the accent locally.

All colors live in `apps/web/src/styles/tokens.css`; components reference CSS
variables only, so adding a family means adding one block there plus an entry in
`COLOR_THEMES`.

## Model labs and logos

Each catalog model can be attributed to the lab that created it, chosen from a
picker in **Admin → Models → Providers & Models → Add/Edit model**.
The lab supplies a logo shown beside the model in the picker and the admin
catalog, with separate light and dark marks selected from the active theme.

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

Limits are named policies applied to roles, managed in
**Admin → Models → Usage budgets**. A role can carry several policies at once
and every one is enforced.

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

Open Chat Interface is available under the [MIT License](LICENSE). Third-party
model logos retain their upstream notices in `apps/web/public/logos/`.
