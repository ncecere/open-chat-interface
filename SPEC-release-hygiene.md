# Spec: release-hygiene

Module of [SPEC.md](SPEC.md) (v0.13). Depends on nothing. Shared commands,
structure, style, testing and boundaries are in SPEC.md; this file adds what
is specific to this module.

## Objective

Pay four small debts found since v0.12.0 so that later modules start from a
clean base:

1. **Drop `project_file_embedding_failure`.** v0.11 replaced it with
   `embedding_generation_failure`; it was kept only because v0.10 replicas
   wrote it during a rolling upgrade (`0041_embedding_generations.sql`: "a
   later release drops it"). No product code at v0.11.1 or v0.12.0 reads or
   writes it (checked: only `apps/api/test/embedding-generations.fixtures.ts`
   and `project-search-hybrid.fixtures.ts` mention it).
2. **Preflight wording.** `upgrade-check` prints "0 of ~rows unknown" for a
   background migration whose table has no estimate yet
   (`apps/api/src/services/migrations/report-text.ts`), and "404 of ~577 rows"
   for a finished one, whose rows changed are not the table's size. System
   health already words both correctly (#263, #281). (A count mismatch seen
   during the v0.11.0 homelab upgrade was not a bug: the log filter used to
   hide credentials also hid `0.11.reencrypt-webhook-secrets`.)
3. **Guard development-image pruning.** On 2026-10-11 a manual run of
   `.github/workflows/prune-dev-images.yml` with `older_than_days=0` and
   `dry_run=false` deleted every `dev-*` image, including the one built a
   minute earlier for `main`, so `dev-env up oci … --ref main` failed until
   the branch was rebuilt.
4. **Roadmap.** `ROADMAP.md` was last updated for v0.11.0: it has no v0.11.1
   or v0.12 entry and no "Now" section.

Users: operators (preflight, a smaller schema), developers (working `dev-env`
images, an accurate roadmap), readers of the roadmap.

**Not in this module:** `auth.saml_config` stays. SAML was removed in v0.12,
but the installed `@better-auth/sso` (1.6.26) still declares and parses
`samlConfig` on the provider row (`dist/index.mjs`), so dropping the column
would break the plugin. Revisit when the plugin no longer declares it.

## Acceptance criteria

### 1. Table drop
- A post-deploy step `packages/db/post/0013_drop_project_file_embedding_failure.sql`
  drops the table (`DROP TABLE IF EXISTS`), with an `oci:lint-allow drop-table`
  comment whose reason names the release that stopped reading it (v0.11.0)
  and the replacement table. It is listed in `post/journal.json` for release
  `0.12.1` (SPEC.md, decision 1).
- The table is removed from `packages/db/src/schema/embeddings.ts`; no
  product code, schema or current docs reference it (`git grep` finds only
  migrations, the post step, the changelog, historical design notes, and the
  two embedding test fixtures, which now drop it in their setup so every
  embedding and project-search live test runs without it).
- `pnpm lint:migrations` passes; the preflight lists the step with the
  table's size.
- Rolling-upgrade test from v0.12.0 passes, and the table is gone after
  `migrate --post`.

### 2. Preflight
- A background migration with no row estimate reads, for example,
  `0.11.usage-rollups on public.usage_event: pending (0 rows so far; size not
  known yet)` instead of `(0 of ~rows unknown)`; a finished one reads
  `(404 rows processed)`; one in progress with an estimate keeps
  `(1,234 of ~5,678 rows)`.
- Unit tests cover the three cases; the reproduction fails first.

### 3. Image pruning
- `prune-dev-images.yml` never deletes an image whose tag is
  `dev-<first 12 hex of the head commit>` of any branch that exists when it
  runs (all branches, listed through the API), whatever the inputs.
- `older_than_days` below **1** is refused with an error, for both scheduled
  and manual runs.
- A dry run (the manual default) lists which images it would delete and
  which it protects and why.
- Proven by running the workflow's selection logic against recorded package
  and branch listings in a script test (`scripts/` with `node --test`), not
  by deleting real images; the workflow calls the same script.

### 4. Roadmap
- Header updated for v0.11.1 and v0.12.0; "Shipped — v0.12" (with v0.11.1's
  QA-walk fixes summarised) and "Now — v0.13" listing this spec's four
  modules with one line each; Later/Under consideration unchanged except
  where v0.12 changed them (SAML removal under Not planned or noted).
- No claim without a source in CHANGELOG.md or the specs.

## Files touched (expected)

`packages/db/post/0013_drop_project_file_embedding_failure.sql`,
`packages/db/post/journal.json`, `packages/db/src/schema/embeddings.ts`,
`apps/api/test/embedding-generations.fixtures.ts`,
`apps/api/test/project-search-hybrid.fixtures.ts`,
`apps/api/src/services/migrations/report-text.ts` (+ preflight count source),
its unit test, `.github/workflows/prune-dev-images.yml`,
`scripts/prune-dev-images.mjs` (new) and its test, `ROADMAP.md`,
`CHANGELOG.md`, `docs/dev/database.md` (the table is gone),
`docs/OPERATIONS.md` (upgrade note for the step).

## Commands (module-specific)

```sh
pnpm lint:migrations
node --test scripts/prune-dev-images.test.mjs
python3 $H/run.py test preflight src/__tests__/unit/<preflight report test>
node tools/upgrade-test/run.mjs --from v0.12.0
```

## Testing strategy

- Preflight wording and count: unit tests (reproduce first).
- Table drop: the linter, a live test that applies the step on a migrated
  database and finds the table gone, and the rolling-upgrade test.
- Pruning: script tests with recorded listings (protected branch heads,
  `older_than_days=0` refused, dry-run report); the workflow runs only as a
  dry run during development.
- Roadmap: reviewed against CHANGELOG.md.

## Boundaries (module-specific)

- **Always:** keep the step idempotent (`IF EXISTS`); keep the pruning change
  dry-run by default for manual runs.
- **Ask first:** dropping anything else; running the pruning workflow for
  real.
- **Never:** drop `auth.saml_config`; delete images while testing the
  workflow.

## Success criteria

All acceptance criteria above hold, every command in SPEC.md passes, and the
change is released as **v0.12.1** (SPEC.md, decision 1) by `docs/RELEASING.md`.
