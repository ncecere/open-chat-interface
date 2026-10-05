# Contributing to Open Chat Interface

Thank you for improving OCI. Contributions must preserve the project's
self-hosted architecture, security boundaries, accessibility, and MIT license.

## Before opening a change

- Use an issue in [the GitHub repository](https://github.com/ncecere/open-chat-interface)
  for substantial features or architectural changes so the design can be agreed
  before implementation.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).
- Keep modules focused; avoid combining unrelated behavior into large files.
- Do not commit credentials, production data, authenticated screenshots, or
  generated runtime data.

## Development setup

OCI requires Node 22+, pnpm 11.18.0 (pinned in `package.json`), and Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

See [README.md](README.md) for service URLs and optional test infrastructure.

## Required checks

Run the checks relevant to your change before opening a pull request:

```bash
pnpm lint
pnpm lint:migrations
pnpm typecheck
pnpm test
pnpm licenses:check
```

For behavior involving PostgreSQL, S3, SMTP, authentication, replication, or
browser interaction, also run the corresponding live or Playwright suites:

```bash
pnpm test:live
pnpm test:e2e
```

Database schema changes must include generated Drizzle SQL and metadata. New or
changed security boundaries require focused tests rather than relying only on a
repository-wide coverage number.

### Migration rules

OCI upgrades without downtime, so a migration must not lock or rewrite a table
that already holds data. `pnpm lint:migrations` (run early in CI) parses every
migration with PostgreSQL's parser and fails on, among others: a plain
`CREATE INDEX` or a validated `ADD CONSTRAINT` on an existing table, `ALTER
COLUMN TYPE`, volatile defaults, `SET NOT NULL` without a validated check,
`UPDATE`/`DELETE`/`INSERT ... SELECT` of existing rows, and `DROP COLUMN` or
`DROP TABLE`. Data changes belong in background migrations (arriving in v0.11),
not in the schema migration. When a statement is genuinely safe, say why
directly above it:

```sql
-- oci:lint-allow index-not-concurrent: one row per organisation
CREATE INDEX "organization_slug_idx" ON "organization" ("slug");
```

Never edit a released migration or add entries to
`scripts/lint-migrations/baseline.json` for a new one; the baseline only
grandfathers migrations written before the linter. See
[docs/dev/database.md](docs/dev/database.md#migration-linter) for every rule
and its fix.

## Pull requests

- Explain the user-visible change, security implications, and deployment or
  migration requirements.
- Include tests and documentation with the implementation.
- Keep commits reviewable and use imperative commit subjects.
- Do not reduce keyboard access, visible focus, contrast, or semantic labeling.
- Do not bypass the curated model catalog, attachment ownership checks, or
  server-side reconstruction of trusted chat history.

GitHub Actions CI must pass before merge. It validates pull requests and `main`
with read-only permissions and does not publish images. Checks include builds,
coverage, production dependency auditing, license policy, and live/browser tests
alongside lint, types, and unit tests, with an S3-compatible service for the
storage, backup and compliance suites. Locally, S3 tests skip without an S3
server; in CI they fail instead.

## Releases

Only maintainers create releases. Stable `vX.Y.Z` tags must point to a validated
commit on `main`, match all package versions, and have a dated entry in
[CHANGELOG.md](CHANGELOG.md). See [docs/RELEASING.md](docs/RELEASING.md).

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
