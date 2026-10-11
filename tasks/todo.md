# Tasks: release-hygiene (v0.12.1)

Plan: [plan.md](plan.md). Spec: [SPEC-release-hygiene.md](../SPEC-release-hygiene.md).
Branch: `patch/v0.12.1`. Shared commands are in [SPEC.md](../SPEC.md)
(`H=/private/tmp/oci-admin-phase0-ww9bw91d`).

## Task 1: Drop `project_file_embedding_failure` in post-deploy step 0013

**Description:** Add a post-deploy step that drops the table v0.11 replaced,
remove it from the Drizzle schema, and update the docs that describe it as
kept.

**Acceptance criteria:**
- [ ] `packages/db/post/0013_drop_project_file_embedding_failure.sql`:
  `DROP TABLE IF EXISTS "project_file_embedding_failure";` with an
  `-- oci:lint-allow drop-table:` reason naming v0.11.0 and
  `embedding_generation_failure`; journal entry `{ idx: 12, tag, release: "0.12.1" }`.
- [ ] Reproduce first: a live test asserts the table is absent after
  `migrate --post` (fails before the step exists), and that embedding and
  project-search paths work afterwards.
- [ ] `projectFileEmbeddingFailure` removed from `packages/db/src/schema/embeddings.ts`;
  `docs/dev/database.md` says it was dropped in v0.12.1. Test fixtures keep
  their exclusion filter (see plan, decision 2).

**Verification:**
- [ ] `pnpm lint:migrations` clean
- [ ] `python3 $H/run.py build && python3 $H/run.py test post src/__tests__/live/post-migrations.live.test.ts <new test>`
- [ ] `pnpm upgrade:check` against a v0.12.0 database lists step 0013 with the table's size

**Dependencies:** None

**Files likely touched:** `packages/db/post/0013_drop_project_file_embedding_failure.sql`,
`packages/db/post/journal.json`, `packages/db/src/schema/embeddings.ts`,
a live test under `apps/api/src/__tests__/live/`, `docs/dev/database.md`

**Estimated scope:** Medium

## Task 2: Preflight wording and background-migration count

**Description:** Make the preflight's background-migration lines read
naturally when no size estimate exists, and make the header count the same
definitions it lists.

**Acceptance criteria:**
- [ ] No estimate: `… pending (0 rows so far; size not known yet)`; with an
  estimate: `… (1,234 of ~5,678 rows)` unchanged.
- [ ] Header count equals the number of lines under "Background migrations";
  test-only definitions are neither counted nor listed unless
  `OCI_TEST_BACKGROUND_MIGRATIONS` names them.
- [ ] Reproduce first: unit tests for both wordings and the count fail on the
  current code.

**Verification:**
- [ ] `python3 $H/run.py test preflight src/__tests__/unit/migration-phases.test.ts`
- [ ] `pnpm --filter @oci/api typecheck`

**Dependencies:** None

**Files likely touched:** `apps/api/src/services/migrations/report-text.ts`,
`apps/api/src/services/migrations/preflight.ts`,
`apps/api/src/__tests__/unit/migration-phases.test.ts`

**Estimated scope:** Small

## Checkpoint A
- [ ] `python3 $H/run.py coverage`: all pass, zero skips, floors hold
- [ ] `pnpm lint:migrations` clean
- [ ] `node tools/upgrade-test/run.mjs --from v0.12.0` passes; the table is gone after `migrate --post`

## Task 3: Guard development-image pruning

**Description:** Move the pruning selection into a tested script that never
selects an image for any existing branch head, refuses `older_than_days < 1`,
and fails closed if branches cannot be listed; the workflow deletes only what
the script selects.

**Acceptance criteria:**
- [ ] `scripts/prune-dev-images.mjs` takes package versions, branch heads,
  `olderThanDays` and `now`, and returns candidates and protected images with
  reasons; `older_than_days < 1` and a missing branch list are errors.
- [ ] Reproduce first: `scripts/prune-dev-images.test.mjs` shows the old
  selection (all `dev-*` older than the cutoff) would delete a branch head's
  image with `older_than_days=0`; the new selection keeps it.
- [ ] `prune-dev-images.yml` lists branches with `gh api --paginate`, calls the
  script, prints protected and candidate images (dry run by default for manual
  runs), and deletes only candidates; permissions unchanged.

**Verification:**
- [ ] `node --test scripts/prune-dev-images.test.mjs`
- [ ] `pnpm lint`
- [ ] After merge to the branch: a manual dry run on GitHub lists `main`'s head as protected

**Dependencies:** None

**Files likely touched:** `scripts/prune-dev-images.mjs`, `scripts/prune-dev-images.test.mjs`,
`.github/workflows/prune-dev-images.yml`

**Estimated scope:** Small

## Task 4: Bring ROADMAP.md up to date

**Description:** Update the roadmap for v0.11.1 and v0.12.0 and add a
"Now — v0.13" section from SPEC.md's capability map.

**Acceptance criteria:**
- [ ] Header names v0.11.1 and v0.12.0; "Shipped — v0.12" summarises v0.11.1
  (nine QA walks, the data-loss fix, code artifacts, report retries) and
  v0.12.0 (SAML removed, emailed invitations verify, timer fixes), each line
  traceable to CHANGELOG.md.
- [ ] "Now — v0.13" lists `accent-search`, `external-backups`,
  `scale-on-cluster` (and v0.12.1's `release-hygiene`) with one line each.
- [ ] SAML's removal is reflected where the roadmap mentions SSO; the table
  of contents links work.

**Verification:**
- [ ] Read against CHANGELOG.md `[0.11.1]` and `[0.12.0]`
- [ ] `pnpm lint` (no effect on Markdown, sanity only)

**Dependencies:** None

**Files likely touched:** `ROADMAP.md`

**Estimated scope:** Small

## Checkpoint B
- [ ] `python3 $H/run.py checks` (real exit code 0)
- [ ] `node --test scripts/*.test.mjs`
- [ ] Review with the human

## Task 5: Changelog, docs and release v0.12.1

**Description:** Write the `[0.12.1]` changelog section and operator notes,
open the PR, then release by `docs/RELEASING.md`.

**Acceptance criteria:**
- [ ] CHANGELOG `[Unreleased]` → `[0.12.1]`: Removed (the table, post-deploy
  step 0013; rollback unaffected), Fixed (preflight wording and count), and a
  development note on pruning; `docs/OPERATIONS.md` per-release upgrade note.
- [ ] PR CI green (application checks, both browser steps, rolling upgrade,
  Helm); merged with `--match-head-commit`.
- [ ] Release PR (`release-prep-0.12.1`: six manifests, `version.ts`, the Helm
  chart, image examples) green and merged; tag `v0.12.1`; multi-arch images and
  the chart published and verified; `dev-env up oci r121 --ref v0.12.1`
  healthy, then down.

**Verification:**
- [ ] `pnpm release:check`, `pnpm lint`, `pnpm typecheck`, `pnpm lint:migrations`,
  `pnpm licenses:check`, `pnpm audit --prod`, `helm lint deploy/helm/open-chat-interface`
- [ ] Publish workflow green; `docker buildx imagetools inspect` shows amd64 and arm64

**Dependencies:** Tasks 1–4

**Files likely touched:** `CHANGELOG.md`, `docs/OPERATIONS.md`, release-prep files

**Estimated scope:** Medium

## Checkpoint C: Complete
- [ ] All acceptance criteria in SPEC-release-hygiene.md met
- [ ] SPEC.md marks `release-hygiene` done
- [ ] Docs site, website and homelab updates are a separate, approved step
