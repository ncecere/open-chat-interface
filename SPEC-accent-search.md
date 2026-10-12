# Spec: accent-search

Module of [SPEC.md](SPEC.md) (v0.13). Depends on nothing. Shared commands,
structure, style, testing and boundaries are in SPEC.md; this file adds what
is specific to this module. Status: **draft, for review.**

## Objective

Make conversation and project search ignore accents for everyone, by
default, at a cost an upgrade can carry. Closes #362.

**Today (v0.12.1):**
- Conversation **titles** ignore accents (`translate()` in the query, no
  index; `apps/api/src/lib/fold.ts`).
- **Message text** is exact about accents unless an operator builds an
  optional expression index by hand
  (`packages/db/optional/message_text_search_folded_index.sql`). Building it
  folds every message during the build: about 1–1.5 ms per message, 339 s on
  the upgrade test's 300,000 messages, which failed that test's latency gate,
  so it is not a post-deploy step.
- **Project file search** (the keyword side, `project_file_chunk.search`, a
  generated column) is not folded.
- `ß`, `æ`, `œ` are not folded anywhere (`translate()` maps one character to
  one).

**Users:** people who search their conversations and projects in French,
Spanish, German, Portuguese, Vietnamese and similar languages, typing with or
without accents; operators, who must not need a manual step or a long upgrade.

**Approach** (from #362: "a stored folded column filled by a throttled
background migration"):

1. A stored, folded search vector per row, maintained by a **database
   trigger** on insert and on change of the text, so every writer is covered:
   twelve code paths update `message.parts`, and v0.12 replicas keep writing
   during a rolling upgrade. Computing it in the trigger costs about 1 ms per
   written message, spread over normal use instead of an upgrade.
2. A **throttled background migration** fills the column for existing rows
   (the v0.11 framework: batches, cursor, lease, pause on replication lag),
   while search keeps using today's exact path.
3. A **post-deploy step** builds a GIN index `CONCURRENTLY` on the stored
   column. On a stored `tsvector` this costs about what
   `message_text_search_idx` does (about 16 s per 100,000 messages measured),
   not the 1–1.5 ms per message of folding during the build.
4. Search switches to the folded column and index once both the backfill and
   the step are finished (`isBackgroundMigrationDone`, `isPostStepDone`), on
   every replica within about 30 s, with no setting.

## Acceptance criteria

### Folding
- The fold maps every precomposed Latin letter with diacritics to its base
  letter (today's table), **and** `ß`→`ss`, `ẞ`→`SS`, `æ`→`ae`, `Æ`→`AE`,
  `œ`→`oe`, `Œ`→`OE` (SPEC.md decision 2). Other scripts are untouched.
- One definition of the fold is used everywhere: the trigger function (SQL),
  the query side (search words), titles, and ts_headline. A test proves the
  SQL function and `apps/api/src/lib/fold.ts` agree on every mapped
  character and on sample text in each affected language.
- Highlighting: a folded match is highlighted in the original text
  (`bibliotheque` highlights "bibliothèque"; `strasse` highlights "Straße").

### Messages
- Pre-deploy migration (lint-clean, no rewrite): nullable
  `message.search_folded tsvector`, an IMMUTABLE SQL function
  `oci_fold_search_text(text)`, and a `BEFORE INSERT OR UPDATE OF parts`
  trigger that sets the column from the same text parts as
  `message_text_search_idx` (skipped on updates that leave `parts` unchanged).
- Background migration `0.13.message-search-folded`: fills rows where the
  column is NULL, in batches by primary key, idempotent, resumable, throttled;
  visible on System health → Background work.
- Post-deploy step: `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  message_search_folded_idx ON message USING gin (search_folded)`.
- Until both are finished, message search behaves exactly as v0.12.1,
  including use of the optional index if an operator built it. Afterwards
  `bibliotheque`, `busqueda`, `strasse` and `oeuvre` find "bibliothèque",
  "Búsqueda", "Straße" and "œuvre" in message text, prefix matching and every
  other search behaviour (filters, ranking, snippets) unchanged.
- Rolling-upgrade test from v0.12.1 passes with the trigger, the backfill and
  the step under load; its p99 and max latency gates hold (the reason the
  optional index was refused).

### Projects
- The same for `project_file_chunk`: a nullable `search_folded` column kept
  by trigger on insert and on change of `content`, a background migration for
  existing chunks, a concurrent GIN index, and the keyword side of project
  search switching once ready. Meaning-based search is unaffected.

### Titles
- Titles fold `ß`, `æ`, `œ` too, with no index (as today).

### The optional index
- `packages/db/optional/message_text_search_folded_index.sql` and its code
  path are removed, and a post-deploy step drops
  `message_text_search_folded_idx` if an operator built it (`DROP INDEX
  CONCURRENTLY IF EXISTS`). Upgrade note: rolling back to v0.12.x afterwards
  loses message accent-insensitivity until that file is run again.
- `docs/OPERATIONS.md` "Accent-insensitive conversation search" is rewritten:
  nothing to do; disk cost; what System health shows.

### Cost, measured
- Measured on the scale harness `small` (500,000 messages) and recorded in
  `docs/dev/scale-harness.md`: insert/update cost of the trigger per message;
  backfill rate; index build time; table and index growth; search p95 before
  and after (target unchanged: < 1 s at `large`).
- The preflight reports the new column's background migration with the
  table's size (no new mechanism).

## Files touched (expected)

`packages/db/drizzle/0047_*.sql` (+ journal), `packages/db/post/0014_*.sql`
onward (+ journal), `packages/db/src/background/` (two definitions),
`packages/db/src/schema/chat.ts`, `packages/db/src/schema/project-search.ts`,
`packages/db/optional/` (removed), `apps/api/src/lib/fold.ts`,
`apps/api/src/services/thread-search.ts`,
`apps/api/src/services/project-search/retrieval.ts`, tests under
`apps/api/src/__tests__/{unit,live}/`, `tools/upgrade-test` (if its checks
need the new step), `docs/OPERATIONS.md`, `docs/dev/database.md`,
`docs/dev/scale-harness.md`, `docs/user/conversations.md`,
`docs/user/projects.md`, `CHANGELOG.md`.

## Commands (module-specific)

```sh
pnpm lint:migrations
python3 $H/run.py test search <thread-search, project-search, fold, migration tests>
node tools/upgrade-test/run.mjs --from v0.12.1
tools/scale/run.sh --profile small --keep        # cost measurements
```

## Testing strategy

- **Reproduce first:** live tests that `bibliotheque`, `busqueda`, `strasse`
  and `oeuvre` find nothing in message text and project chunks on v0.12.1
  behaviour (fail), then pass once backfill and step are done.
- **Fold:** unit tests for the table and the multi-letter cases; a live test
  comparing the SQL function with `fold.ts` over every mapped character.
- **Trigger:** live tests for insert, update of parts, update without parts
  (column untouched), and a write through each of the twelve update paths'
  shapes (at least one per service).
- **Switch-over:** live tests that search uses the exact path while the
  backfill or the step is unfinished, and the folded path after; and that a
  row written mid-backfill is folded once (trigger) and not double-counted.
- **Upgrade:** the rolling-upgrade test from v0.12.1 under load.
- **Scale:** the harness measurements above.

## Boundaries (module-specific)

- **Always:** keep `message_text_search_idx` and the exact path until a later
  release removes them (the previous release uses them; rollback needs them);
  keep the trigger cheap (no work when `parts` is unchanged).
- **Ask first:** a stored generated column or anything that rewrites
  `message` or `project_file_chunk`; requiring the backfill in
  `releases.json` (that belongs to the release that removes the exact path).
- **Never:** make an upgrade wait for the backfill or a slow index build;
  depend on an extension (`unaccent`).

## Success criteria

The acceptance criteria hold; #362 is closed; the rolling-upgrade test
passes from v0.12.1; the measurements are recorded.

## Open questions (recommendations, awaiting confirmation)

1. **Disk: store the folded vector only where folding changes the text.**
   Most text has no foldable letters, and for it the folded text equals the
   original, so a second copy is waste. Recommended: the trigger leaves
   `search_folded` NULL when `oci_fold_search_text(text) = text`; the index
   is partial (`WHERE search_folded IS NOT NULL`); search folds the query
   words and matches them against **both** the existing exact index
   (unaccented text: folded words equal the original) **and** the folded
   index (text with accents), combined by PostgreSQL's bitmap OR. Same
   results; extra disk only for messages and chunks that contain foldable
   letters; the backfill writes only those rows (it still reads all). The
   exact index then stays as the main path for good, with no later removal.
   The acceptance criteria and cost measurements above change accordingly
   (measure the share of rows stored, and search p95 with the OR).
2. **The optional index: drop it in v0.13** (as specified above). Few will have
   built it; where they did, it slows every message write and is unused once
   the new path is ready. Rolling back to v0.12.x afterwards loses message
   accent-insensitivity until the optional file is run again (upgrade note).
3. **One IMMUTABLE SQL function** `oci_fold_search_text(text)` for the trigger,
   the query and ts_headline, replacing the literals spliced into each query.
   Rule to record in `docs/dev/database.md`: because the index is on a stored
   column, any change to the fold needs a background migration that
   recomputes `search_folded`.
