# Tasks: v0.13 (search, backups and scale)

Plan: [plan.md](plan.md). Specs: [SPEC.md](../SPEC.md), [SPEC-accent-search.md](../SPEC-accent-search.md).
Shared commands are in SPEC.md (`H=~/.oci-harness`).

## Task 1: `RUN_POST_MIGRATIONS=auto` and the chart (#385) ✅

**Acceptance criteria:**
- [x] `RUN_POST_MIGRATIONS` accepts `auto`: a replica that does not migrate itself applies post-deploy steps once every replica that heartbeats reports this release (needs Redis), and waits otherwise. Reproduced first: the chart gave the worker nothing, and the tests failed.
- [x] With the hooks off the chart sets it on the worker, and with them on nothing changes (checked in `helm.yml`).
- [x] Docs and changelog updated.

**Verification:** `python3 $H/run.py test auto ...` (30 tests), `helm lint --strict`, the new chart CI step, full coverage and `checks`.

## Checkpoint A
- [ ] `python3 $H/run.py coverage`, `python3 $H/run.py checks`, `node --test scripts/*.test.mjs`
- [ ] Chart CI green; merged to `main`

## Task 2: One fold: `oci_fold_search_text`

**Description:** A SQL function holds the fold, with `ß æ œ`, and every caller of the fold uses it.

**Acceptance criteria:**
- [ ] Migration `0047` creates `oci_fold_search_text(text)` (IMMUTABLE, PARALLEL SAFE, STRICT): today's `translate()` table, then `ß`→`ss`, `ẞ`→`SS`, `æ`→`ae`, `Æ`→`AE`, `œ`→`oe`, `Œ`→`OE`.
- [ ] `apps/api/src/lib/fold.ts` (`foldAccents`, `foldSql`) is extended the same way, and `foldSql` calls the function.
- [ ] Reproduce first: titles and the title highlight do not find `strasse` for "Straße" or `oeuvre` for "œuvre" before; they do after. A live test compares the SQL function with `foldAccents` over every mapped character and sample text in French, Spanish, German, Portuguese, Vietnamese, Polish, Turkish; a unit test keeps the migration's literals equal to the table in `fold.ts`.

**Verification:** targeted tests; `pnpm lint:migrations`; `pnpm --filter @oci/api typecheck`.

**Dependencies:** Checkpoint A (a clean `main`)

**Files likely touched:** `packages/db/drizzle/0047_*.sql` + journal, `apps/api/src/lib/fold.ts`, `apps/api/src/services/thread-search.ts`, tests

**Estimated scope:** Medium

## Task 3: Messages

**Description:** `message.search_folded`, its trigger, the background migration, the post-deploy index, and the search switching over.

**Acceptance criteria:**
- [ ] Migration `0048`: nullable `message.search_folded tsvector`; trigger function and `BEFORE INSERT OR UPDATE OF parts` trigger; NULL when folding leaves the text unchanged; no work when `parts` is unchanged on update.
- [ ] Background migration `0.13.message-search-folded` in `packages/db/src/background/`: by primary key, idempotent, resumable, writes only rows whose text has foldable letters.
- [ ] Post-deploy step `0014_message_search_folded_index`: partial GIN, `CONCURRENTLY`.
- [ ] `thread-search.ts`: ready means the background migration and step 0014 are both done (`isBackgroundMigrationDone`, `isPostStepDone`; never awaited inside a transaction); then the folded query words match the exact index OR the folded one, and rank uses `coalesce(search_folded, <exact vector>)`; before that, exactly v0.12.1.
- [ ] Reproduce first: `bibliotheque`, `busqueda`, `strasse`, `oeuvre` find nothing in message text before and everything after; the result is a superset of the old path's; `EXPLAIN` shows both indexes; a row written mid-backfill is found once.

**Verification:** live tests (trigger shapes, switch-over, parity, EXPLAIN); `pnpm lint:migrations`.

**Dependencies:** Task 2

**Files likely touched:** `packages/db/drizzle/0048_*.sql` + journal, `packages/db/post/0014_*.sql` + journal, `packages/db/src/background/*`, `packages/db/src/schema/chat.ts`, `apps/api/src/services/thread-search.ts`, tests

**Estimated scope:** Large; split into the migration and trigger first, then the backfill and index, then the query, with a commit each.

## Task 4: Project file chunks

**Acceptance criteria:**
- [ ] Migration `0049`: nullable `project_file_chunk.search_folded` and its trigger (insert and update of `content`; NULL when unchanged by folding).
- [ ] Background migration `0.13.chunk-search-folded`; no index, no post-deploy step.
- [ ] `retrieval.ts` reads `coalesce(search_folded, search)` with folded terms once the migration is done, `search` as today before.
- [ ] Reproduce first: `bibliotheque` finds a passage containing "bibliothèque" and the reverse, only after.

**Verification:** live tests; the 95 project-search tests still pass; `pnpm lint:migrations`.

**Dependencies:** Task 2

**Files likely touched:** `packages/db/drizzle/0049_*.sql` + journal, `packages/db/src/background/*`, `packages/db/src/schema/project-search.ts`, `apps/api/src/services/project-search/retrieval.ts`, tests

**Estimated scope:** Medium

## Task 5: Remove the optional index

**Acceptance criteria:**
- [ ] `packages/db/optional/message_text_search_folded_index.sql`, `foldedSearchReady` and its tests are removed; post-deploy step `0015_drop_message_text_search_folded_index` (`DROP INDEX CONCURRENTLY IF EXISTS`, with the linter's allow comment).
- [ ] `docs/OPERATIONS.md` "Accent-insensitive conversation search" rewritten; `docs/dev/database.md` records that a change to the fold needs a background migration; `docs/user/conversations.md` and `projects.md`; CHANGELOG with an upgrade note (rollback to v0.12.x loses message accent-insensitivity until the optional file is run).

**Dependencies:** Tasks 3 and 4

**Estimated scope:** Medium

## Checkpoint B
- [ ] Full coverage (zero skips, floors hold), `checks`, `pnpm lint:migrations`, `node tools/upgrade-test/run.mjs --from v0.12.1` pass
- [ ] Scale harness `small` measurements recorded in `docs/dev/scale-harness.md`
- [ ] PR CI green

## Phase 3 and 4: specs for #386 and #387
- [ ] Task 6: `SPEC-external-backups.md` reviewed and approved (drafted)
- [ ] Task 7: `SPEC-scale-on-cluster.md` written, reviewed and approved

## Checkpoint C: v0.13.0 released
