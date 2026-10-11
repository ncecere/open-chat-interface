# Implementation Plan: release-hygiene (v0.12.1)

Spec: [SPEC-release-hygiene.md](../SPEC-release-hygiene.md), part of
[SPEC.md](../SPEC.md). Tasks: [todo.md](todo.md).

## Overview

Four small, independent debts, shipped together as v0.12.1: drop the unused
`project_file_embedding_failure` table in a post-deploy step, fix the upgrade
preflight's wording and count, guard the development-image pruning workflow,
and bring `ROADMAP.md` up to date. Each is its own vertical slice (change,
test, docs) and leaves `main` releasable.

## What the code looks like today (read before planning)

- **The table:** declared in `packages/db/src/schema/embeddings.ts`
  (`projectFileEmbeddingFailure`, an index and two checks). No product code
  at v0.11.1 or v0.12.0 reads or writes it. Two test fixtures mention it only
  to *exclude* it when listing generation tables by name
  (`apps/api/test/embedding-generations.fixtures.ts:246`,
  `apps/api/test/project-search-hybrid.fixtures.ts:142`, both
  `tablename like 'project_file_embedding%'`). Docs mention it in
  `docs/dev/database.md:475` (kept for v0.10 replicas) and
  `docs/OPERATIONS.md:881` (history; v0.9's migration 0029).
- **Post-deploy steps:** one statement per file in `packages/db/post/`, listed
  in `post/journal.json` as `{ idx, tag, release }`; the last is
  `0012_attachment_thumbnail_key_index` (release `0.11.0`). Drops are allowed
  only in post-deploy, with `-- oci:lint-allow drop-table: <reason>`.
  `apps/api/src/__tests__/live/post-migrations.live.test.ts` applies steps
  against real PostgreSQL.
- **Preflight text:** `renderReport` in
  `apps/api/src/services/migrations/report-text.ts`; line 72 prints
  `(N of ~${rows(estimate)})`, where `rows(null)` is `'rows unknown'`. The
  header's count is `definitions.length` (`preflight.ts:346`); the listed lines
  are `report.background`. Unit tests in
  `apps/api/src/__tests__/unit/migration-phases.test.ts`.
- **Pruning:** all logic is inline bash and `jq` in
  `.github/workflows/prune-dev-images.yml`; candidates are versions whose tags
  are all `dev-<12 hex>` and older than the cutoff; no floor on
  `older_than_days`, no protection for branch heads. Script tests run with
  `node --test scripts/*.test.mjs` (as `ghcr-release.test.mjs`).

## Architecture decisions

- **Drop in a post-deploy step, not a pre-deploy migration.** The linter
  refuses drops in pre-deploy; post-deploy runs after every replica runs
  v0.12.1, and v0.12.0 replicas never touch the table, so a rolling upgrade is
  safe either way. `DROP TABLE IF EXISTS` keeps it idempotent; its index and
  checks go with it. The Drizzle schema export goes too (nothing imports it).
- **The two embedding test fixtures drop the table in their setup**, as step
  0013 does, instead of excluding it by name. Test databases are built from
  pre-deploy migrations, which still create it; dropping it first makes every
  embedding-generation and hybrid-search live test (63) prove that nothing
  needs it. A new live test proves step 0013 removes it and is idempotent.
- **Pruning logic moves to `scripts/prune-dev-images.mjs`** (plain Node, no
  dependency) so it can be tested with recorded listings; the workflow calls
  it with `gh api` output. It protects `dev-<sha12>` of every branch head
  (listed with `gh api --paginate repos/{owner}/{repo}/branches`) and refuses
  `older_than_days < 1`. Deletion stays in the workflow step, driven by the
  script's list, so the script itself never calls the API.
- **Preflight:** no change to the report's data, only to its text and to
  which definitions the header counts (the same filtered list it lists).

## Task list

### Phase 1: Schema and upgrade tooling
- [x] Task 1: Drop `project_file_embedding_failure` in post-deploy step 0013
- [x] Task 2: Preflight wording (the count was not a bug)

### Checkpoint A ✅
- [x] `run.py coverage` (2,472/2,472, zero skips, floors hold; first run caught three pinned lists), `pnpm lint:migrations`
- [x] Rolling-upgrade test from v0.12.0: PASS (0 errors, p99 228 ms, 216 replies complete, 0 cut; step 0013 applied in the post-deploy phase)

### Phase 2: CI and docs
- [x] Task 3: Guard development-image pruning
- [x] Task 4: Bring ROADMAP.md up to date

### Checkpoint B ✅
- [x] `run.py checks` (real exit code 0), `node --test scripts/*.test.mjs` (139/139)
- [x] The prune workflow's dry run on GitHub kept the branch head, 0 candidates (main has no image after the 2026-10-11 prune)
- [x] Review with the human (the `/build auto` approval; the tag waits for sign-off)

### Phase 3: Release
- [ ] Task 5: Changelog and docs for v0.12.1, then release by `docs/RELEASING.md`

### Checkpoint C: Complete
- [ ] PR CI green (incl. the rolling-upgrade workflow); merged
- [ ] v0.12.1 tagged; multi-arch images and chart published and verified
- [ ] `dev-env up oci … --ref v0.12.1` healthy, then down
- [ ] Spec marked done in SPEC.md

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Something still reads the table (missed reference) | High: errors after `migrate --post` | `git grep` at v0.12.0 and on the branch (done: product code clean); a live test exercises embedding and project search after the step; the rolling-upgrade test runs v0.12.1 under load after `migrate --post`. v0.12.0 replicas are already replaced when the step runs, and never read the table anyway. |
| Rolling back to v0.12.0 after the step | Low: v0.12.0 never reads it | Note in the changelog that rollback is unaffected. |
| Branch listing in the prune workflow fails (API error) | Medium: could prune a head | Fail closed: if branches cannot be listed, delete nothing. Test it. |
| Testing the prune workflow deletes real images | Medium | Only dry runs during development; the script is pure and tested offline. |
| Roadmap claims drift from the changelog | Low | Every line cites a CHANGELOG section; reviewed in Checkpoint B. |

## Parallelization

Tasks 1–4 touch disjoint files and could run in parallel, but they are
small; doing them sequentially in one branch (`patch/v0.12.1`) avoids
merge noise. Task 5 depends on all of them.

## Open questions

None.
