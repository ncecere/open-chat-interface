# Spec: Open Chat Interface v0.13 (index)

Status: **map approved 2026-10-11; `release-hygiene` shipped as v0.12.1; `accent-search` approved and building; `external-backups` spec drafted; `scale-on-cluster` not yet specified.** The chart gap #385 (found during v0.12.1) ships in v0.13.0 too. This file is
the index: the approved capability map, the build order, and what every
module shares (commands, structure, style, testing, boundaries). Each module
has its own spec, named by its id. The map, not file names, says what exists.

## Objective

Close the work left open after v0.12.0: the one open issue (#362), the
item deferred from v0.11 ("backups at scale"), the service objectives not
yet shown to hold at the `large` scale, and small release-hygiene debts found
since. The users are the same as OCI's: people who chat (search),
administrators (backups, System health) and operators (upgrades, backups,
capacity); developers benefit from the hygiene work.

## Capability map

| Module id | Responsibility | Depends on | Spec |
|---|---|---|---|
| `release-hygiene` | Drop `project_file_embedding_failure`; preflight report wording; guard development-image pruning; bring `ROADMAP.md` up to date | — | [SPEC-release-hygiene.md](SPEC-release-hygiene.md) — **done, v0.12.1** |
| `accent-search` | Accent-insensitive search of message text by default: a stored folded column filled by a throttled background migration, its index built concurrently, search falling back until both are ready; project/file keyword search folded too; ß, æ, œ (#362) | — | [SPEC-accent-search.md](SPEC-accent-search.md) — **approved, building** |
| `external-backups` | An "external database backup" mode for clusters with their own backups: OCI copies attachments and verifies, documents recovery objectives, and has a restore drill | — | [SPEC-external-backups.md](SPEC-external-backups.md) — **approved, building** |
| `scale-on-cluster` | Run `tools/scale` up to `large` against a `dev-env` environment on the cluster and publish the results against the service objectives | `accent-search` | [SPEC-scale-on-cluster.md](SPEC-scale-on-cluster.md) — **approved; tooling built, medium and large not yet run** |

Build order: `release-hygiene` → `accent-search`, `external-backups` (one
adds migrations at a time) → `scale-on-cluster`.

Out of scope: the homelab's own manifests (the API's `Recreate` strategy, the
Caddyfile's health settings) are changed in `~/homelab/bitop-talos`, not here,
and only when asked.

## Tech stack (unchanged)

TypeScript on Node 22, pnpm 11.18 workspaces with Turbo: `apps/api` (Hono,
Better Auth, Drizzle on postgres.js with the patch in `patches/`),
`apps/web` (React, TanStack Router, Vite), `packages/db` (schema,
migrations, post-deploy steps, background migrations), `packages/shared`
(Zod schemas). PostgreSQL 17 with pgvector, Redis, S3-compatible storage.
Deployed with Docker Compose or the Helm chart (`deploy/helm`). No new
runtime service or dependency without asking.

## Commands

```sh
# Harness: ~/.oci-harness (run.py + compose.yaml) mirrors CI's services and
# environment (PostgreSQL 17 + pgvector, Redis, Mailpit, VersityGW S3) on
# 127.0.0.1-only ports, with a sanitized environment. It lives outside
# /private/tmp, which macOS clears on restart.
H=~/.oci-harness
python3 $H/run.py up            # start the services (down: stop and wipe them)
python3 $H/run.py install       # pnpm install --frozen-lockfile, sanitized

pnpm lint                 # biome check .
pnpm typecheck            # turbo run typecheck
pnpm lint:migrations      # migration linter (pre-deploy and post-deploy rules)
pnpm licenses:check
pnpm audit --prod
pnpm release:check        # versions, Helm chart and CHANGELOG agree

# Tests (real PostgreSQL, Redis, SMTP, S3)
python3 $H/run.py build
python3 $H/run.py test <report-name> <files…>   # targeted, from apps/api
python3 $H/run.py coverage                       # API: all pass, zero skips, floors hold
python3 $H/run.py web tests/unit
python3 $H/run.py checks                         # typecheck, lint, migration lint, licences, web unit; real exit code
# e2e: as CI's two browser steps (seeded, then the deterministic fixture); see
# .github/workflows/ci.yml and docs/dev/testing.md

# Upgrades and scale
node tools/upgrade-test/run.mjs                  # from the previous release, under load
tools/scale/run.sh --profile small               # tiny | small | medium | large
pnpm upgrade:check                               # preflight against a database

# On the cluster (AGENTS.md): push the branch, wait for "Branch images"
DEVENV=~/homelab/bitop-talos/tools/dev-env/dev-env
$DEVENV up oci <name> --ref <branch>; $DEVENV forward oci <name>; $DEVENV down oci <name>
```

## Project structure (where module work goes)

```
apps/api/src/routes/…            HTTP routes (admin under routes/admin)
apps/api/src/services/…          domain logic (migrations/, backups/, thread-search…)
apps/api/src/__tests__/{unit,integration,live}/   API tests (live = real services)
apps/web/src/{routes,components,hooks,lib}/       web app
apps/web/tests/{unit,e2e}/                         web tests
packages/db/drizzle/NNNN_*.sql   pre-deploy migrations (Drizzle journal)
packages/db/post/NNNN_*.sql      post-deploy steps (+ post/journal.json)
packages/db/src/background/      background migrations
packages/db/releases.json        what a release requires finished first
docs/{admin,user,dev}/, docs/OPERATIONS.md, CHANGELOG.md, ROADMAP.md
tools/{scale,upgrade-test,failover-drill}/, deploy/{helm,monitoring}/
.github/workflows/
```

## Code style

Biome formatting and lint (`pnpm lint`); English comments that say why, not
what. A post-deploy step is one statement with a comment naming the issue:

```sql
-- As 0011, for the thumbnail of an attachment (#358): partial, because most
-- rows have none.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "attachment_thumbnail_key_idx" ON "attachment" ("thumbnail_key") WHERE "thumbnail_key" IS NOT NULL;
```

Plain, specific English in docs and UI copy ("message limit for today", not
the budget's name). Changelog entries follow the existing sections (Added,
Changed, Removed, Fixed) with an **Upgrade note** wherever an operator must act.

## Testing strategy (every module)

- Reproduce first: a test that fails on the current code, then passes.
- Real PostgreSQL 17, Redis, SMTP and S3 through the harness; zero skips;
  coverage floors hold (raise them for new modules).
- Migrations: `pnpm lint:migrations` clean; the rolling-upgrade test from
  the previous release passes with the new steps under load.
- UI changes: web unit tests, e2e, and QA screenshots read before merging.
- Branches with runtime changes are also brought up with `dev-env` and
  checked (health, sign-in, the feature); environments are taken down after.

## Boundaries (every module)

- **Always:** reproduce before fixing; keep the previous minor release working
  against the new schema (rolling upgrades); validate with the commands above;
  update CHANGELOG and docs with the change; take down `dev-env` environments
  you start; keep `image*.png` files in the repo root out of git.
- **Ask first:** schema drops beyond those named in a module spec; new
  dependencies or services; CI workflow changes that publish or delete
  anything; anything in `~/homelab/bitop-talos`; releasing.
- **Never:** write the model gateway's real name (it is "University AI
  gateway"; the DGX models are "Research compute"); print or commit secrets;
  touch the `open-chat-interface` (production) namespace or any namespace
  other than `dev-oci` to test; skip or delete a failing test to get green.

## Success criteria (v0.13 as a whole)

- Each module's own success criteria are met and its spec is marked done.
- v0.13.0 is released by `docs/RELEASING.md`: CI green, multi-arch images and
  the chart published, the rolling-upgrade test passes from v0.12.0.
- Issue #362 is closed.

## Decisions (2026-10-11)

1. **Release split:** `release-hygiene` ships alone as **v0.12.1**; the other
   three modules are **v0.13.0**.
2. **`accent-search`:** accents are folded for everyone by default, no
   setting; "ß" matches "ss", "æ" matches "ae", "œ" matches "oe".
3. **`external-backups`:** CloudNativePG and pgBackRest are supported and
   tested; WAL-G is documented only.
4. **`scale-on-cluster`:** the `large` profile may run on the shared cluster.
   Measured capacity (2026-10-11): the local volume pool (`local-dev`,
   a loop file in `/var/lib/miroir`) has a 200 GiB quota on talos-cp-1 and
   talos-cp-3 (NVMe, ~476 GB free on each node) and is nearly empty; the
   `large` database is estimated at ~70 GB, so the run uses
   `dev-env up … --pg-size 150Gi` (75% of the pool, under the existing 85%
   alert). Because that pool shares the NVMe with the control-plane node's
   system disk and etcd, the module spec must pin the run to cp-1 or cp-3
   (never cp-2, SATA), generate data in-cluster and throttled, watch etcd
   fsync latency and pool usage and stop automatically past a threshold, run
   at a quiet time, and tear everything down after. Fallback: `nfs-dev`.

## Open questions

None at the index level.
