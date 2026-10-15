# Spec: Open Chat Interface v0.14 (index)

Status: **map and module specs approved 2026-10-14 under the maintainer's delegation ("use your judgement"); building.** This file is
the index: the capability map, the scope decisions, the build order, and what every module shares (commands,
structure, style, testing, boundaries). Each module has its own spec, named by its id (`SPEC-<id>.md`). The v0.13
specs are in `specs/v0.13/`.

## Objective

Close the "governance and access" and "reach and compliance" items the roadmap lists for v1.0: groups and
delegated administration (#394), data classification for models and connectors (#395), multi-factor
authentication for local accounts (#399), interface translations and right-to-left layout (#397), an installable
app (#400) and an accessibility conformance report (#401). The users are the same as OCI's: people who chat
(language, installing, MFA), group managers (a new kind of delegated administrator), administrators (groups,
classification, MFA policy) and institutions that buy software (the conformance report).

## Capability map

| Module id | Responsibility | Issue | Depends on | Spec |
|---|---|---|---|---|
| `mfa` | TOTP and recovery codes for local accounts (Better Auth's `twoFactor`), passkeys if the official package fits, an option to require MFA per role, safe for the break-glass administrator | #399 | — | `SPEC-mfa.md` |
| `installable-app` | A web manifest served by the instance (its name, colours, icons), install metadata; no offline mode | #400 | — | `SPEC-installable-app.md` |
| `data-classification` | Admin-defined data classes; models and connectors approved per class; conversations carry classes (project, connector use, a person's label); warn or block when one crosses to an unapproved model or connector | #395 | — | `SPEC-data-classification.md` |
| `groups` | Groups of people, delegated group managers, group budgets and model access, projects shared with people or groups as viewer or editor | #394 | — | `SPEC-groups.md` |
| `i18n` | A translation framework without a new dependency, per-person and instance language, right-to-left layout, the end-user surfaces translated, a contributor guide; English plus (beta) Spanish and Arabic | #397 | the features above (strings are extracted last) | `SPEC-i18n.md` |
| `accessibility-report` | A WCAG 2.2 AA review of every route (automated, keyboard, accessibility tree, reflow, contrast, target size), the fixes it finds, and a published conformance report in the VPAT 2.5 layout that states its method and limits | #401 | everything above (it reviews the final UI) | `SPEC-accessibility-report.md` |

Build order: `mfa`, `data-classification`, `groups`, `installable-app` in parallel (each in its own worktree and
branch, migrations numbered in advance); then `i18n` string extraction; then `accessibility-report`; then the
release. Migrations are numbered in advance so branches do not collide: `0050` and `0051` mfa, `0052`
data-classification, `0053` and `0054` groups. `0055_user_locale` i18n (a nullable preference column). `installable-app` needs none (branding is JSON).

## Scope decisions (2026-10-14)

1. **Custom roles are not in v0.14.** The four roles are a closed list that 85 source files and every per-role
   setting (limits, model visibility, features, tools, storage) key off. Making roles data touches all of them;
   it deserves its own release. **Groups** cover the use case the issue gives ("departments need their own
   limits"): they add limits, model access and delegated management on top of a person's role. #394 is split:
   groups, delegated managers and shared projects ship; custom roles move to a new issue.
2. **Passkeys are included only if the official `@better-auth/passkey` package fits Better Auth 1.6.26** and its
   licences pass `pnpm licenses:check`; otherwise v0.14 ships TOTP and recovery codes and says so. A passkey sign-in
   counts as MFA for the policy. People who sign in through single sign-on are exempt: their identity provider
   enforces it.
3. **Classification is deny-by-default.** A model approved for no class cannot receive labelled content. Turning
   the feature on changes nothing until something is labelled. Modes: off (default), warn, block.
4. **Shared projects keep conversations private.** A viewer or editor uses the project's instructions and files in
   their own conversations, which stay theirs. Only the owner deletes or reshares. Files count against the
   uploader's storage.
5. **Translations: framework, RTL and the end-user surfaces; the admin console stays English.** No translation
   library is added (`Intl` plus a small typed catalog). Spanish and Arabic are machine-drafted, shown as beta,
   and the docs invite native review. Pseudo-locales exist for tests.
6. **The conformance report is a self-assessment**, not a third-party audit, and says exactly how it was made
   (including that no screen reader was driven by a person). It recommends an independent audit for procurement
   that needs one.

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

## Success criteria (v0.14 as a whole)

Every module's acceptance criteria hold; `python3 $H/run.py coverage` passes with zero skips and the floors hold
(new floors for new services); `checks`, `pnpm lint:migrations`, `pnpm release:check`, licences and audit pass;
`node tools/upgrade-test/run.mjs --from v0.13.1` passes (new migrations are additive and rolling-safe);
`packages/db/releases.json` has an entry for 0.14.0 (a test enforces it); the browser suites pass including MFA
and passkeys with a virtual authenticator; the branch is checked on `dev-env` (sign-in with MFA, a group, a
classified conversation, a Spanish and an Arabic session, installing); docs, CHANGELOG, ROADMAP and the upgrade
notes are updated; the release follows `docs/RELEASING.md`.

## Boundaries (v0.14 additions)

- **Always:** access checks are server-side and deny by default; every new endpoint has a permission test that
  proves a person without the right gets 403 or 404 (never data); audit events for every administrative change.
- **Ask first / decided here:** the only new dependencies this release may add are `@better-auth/passkey` 1.6.26
  (API, decision 2) and `qrcode-generator` (web, for the TOTP enrolment QR code; MIT, no dependencies). No other.
- **Never:** weaken an existing access check to make a feature fit; skip a test; ship an unreviewed translation
  without the beta label; claim in the conformance report anything that was not tested.
