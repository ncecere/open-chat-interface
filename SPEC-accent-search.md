# Spec: accent-search

Module of [SPEC.md](SPEC.md) (v0.13). Depends on nothing. Shared commands,
structure, style, testing and boundaries are in SPEC.md; this file adds what
is specific to this module. Status: **approved to build** (2026-10-12; the
three recommendations in the draft were adopted: see Decisions).

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

**Approach:**

1. **One fold**, an IMMUTABLE SQL function `oci_fold_search_text(text)` owned
   by the schema: today's `translate()` table plus `ß`→`ss`, `ẞ`→`SS`,
   `æ`→`ae`, `Æ`→`AE`, `œ`→`oe`, `Œ`→`OE`. The trigger, the queries, titles
   and highlighting all use it; `fold.ts` holds the same table for the
   TypeScript side and tests prove they agree.
2. **A stored folded search vector, only where folding changes the text.**
   `message.search_folded` (nullable `tsvector`) is set by a **database
   trigger** on insert and on change of `parts` (twelve code paths update
   `message.parts`, and v0.12 replicas keep writing during a rolling upgrade,
   so application code is not enough). It stays NULL when the text has no
   foldable letter: for such text the folded words equal the original words,
   so the existing exact index already finds them.
3. **A partial GIN index** `message_search_folded_idx ... WHERE search_folded
   IS NOT NULL`, built `CONCURRENTLY` by a post-deploy step while the column
   is still mostly NULL, so it is cheap. It stays small: it holds only
   messages that contain foldable letters.
4. **A throttled background migration** (`0.13.message-search-folded`) fills
   the column for existing rows by primary key; it writes only the rows whose
   text has foldable letters.
5. **Search folds the query words and matches both**: the exact index
   (unaccented text) and the folded index (text with accents), combined by
   PostgreSQL's bitmap OR. Until the backfill and the post-deploy step are
   both finished, message search behaves exactly as v0.12.1. It switches by
   itself, on every replica within about 30 s, with no setting.
6. **Project file chunks** need no index. Keyword search runs over a
   materialized scope of one project's chunks (`scopedChunks`), never over
   the GIN index. `project_file_chunk.search_folded` (nullable, trigger on
   insert and on change of `content`, background migration
   `0.13.chunk-search-folded`) makes the *folded vector* of every chunk
   simply `coalesce(search_folded, search)`, which the keyword side reads
   instead of `search`, with folded terms.

## Acceptance criteria

### Folding
- `oci_fold_search_text` maps every precomposed Latin letter with diacritics
  to its base letter (today's table) **and** `ß`→`ss`, `ẞ`→`SS`, `æ`→`ae`,
  `Æ`→`AE`, `œ`→`oe`, `Œ`→`OE` (SPEC.md decision 2). Other scripts are
  untouched.
- A test proves the SQL function and `apps/api/src/lib/fold.ts` agree on every
  mapped character and on sample text in French, Spanish, German, Portuguese,
  Vietnamese, Polish and Turkish; a unit test keeps the migration's literals
  equal to `fold.ts`'s table.
- Highlighting: a folded match is highlighted in the original text
  (`bibliotheque` highlights "bibliothèque"; `strasse` highlights "Straße").
  The existing `headlineQuery` already builds its query from the document's
  own words whose folded form starts with a search word; it uses the new fold.

### Messages
- Pre-deploy migrations (lint-clean, no rewrite): `0047` (the function),
  `0048` (nullable `message.search_folded tsvector`, the trigger function and
  `BEFORE INSERT OR UPDATE OF parts` trigger that sets it from the same text
  parts as `message_text_search_idx`, NULL when unchanged by folding, and
  skipped on updates that leave `parts` unchanged).
- Background migration `0.13.message-search-folded`: batches by primary key,
  idempotent, resumable, throttled; visible on System health → Background
  work.
- Post-deploy step `0014_message_search_folded_index`: `CREATE INDEX
  CONCURRENTLY IF NOT EXISTS message_search_folded_idx ON message USING gin
  (search_folded) WHERE search_folded IS NOT NULL`.
- Until both are finished, message search behaves exactly as v0.12.1.
  Afterwards `bibliotheque`, `busqueda`, `strasse` and `oeuvre` find
  "bibliothèque", "Búsqueda", "Straße" and "œuvre" in message text; prefix
  matching and every other search behaviour (filters, ranking, snippets)
  unchanged; the result for any query is a superset of v0.12.1's.
- `EXPLAIN` of each branch of the search statement shows its index used. The branches are joined by `UNION`, not `OR` (an `OR` over the computed exact vector let the planner scan every message of the person; found by the rolling-upgrade test in CI).
- The rolling-upgrade test from v0.12.1 passes with the triggers, the
  backfill and the step under load; its p99 and max latency gates hold (the
  reason the optional index was refused).

### Projects
- Pre-deploy migration `0049`: nullable `project_file_chunk.search_folded`
  and its trigger (insert, and update of `content`; NULL when unchanged by
  folding). Background migration `0.13.chunk-search-folded`. No new index, no
  post-deploy step. Keyword search reads `coalesce(search_folded, search)` with
  folded terms once the migration is done, and `search` as today before. The
  meaning-based (embedding) side is unaffected.
- `bibliotheque` finds a passage containing "bibliothèque", and the reverse.

### Titles
- Titles fold `ß`, `æ`, `œ` too, with no index (as today), through the same
  function.

### The optional index
- `packages/db/optional/message_text_search_folded_index.sql`, its code path
  (`foldedSearchReady` and the expression it must match) and its tests are
  removed, and post-deploy step `0015_drop_message_text_search_folded_index`
  drops `message_text_search_folded_idx` if an operator built it (`DROP INDEX
  CONCURRENTLY IF EXISTS`, with the linter's allow comment). Upgrade note:
  rolling back to v0.12.x afterwards loses message accent-insensitivity until
  that file is run again.
- `docs/OPERATIONS.md` "Accent-insensitive conversation search" is rewritten:
  nothing to do; what it costs; what System health shows.

### Cost, measured
- Measured on the scale harness `small` (500,000 messages) and recorded in
  `docs/dev/scale-harness.md`: the share of messages and chunks stored
  (depends on the generated text's languages: report it for the harness's
  mix and for an accent-heavy mix); trigger cost per insert; backfill rate;
  index build time; table and index growth; search p95 before and after
  (target unchanged: < 1 s at `large`).

## Files touched (expected)

`packages/db/drizzle/0047_*.sql`, `0048_*.sql`, `0049_*.sql` (+ journal),
`packages/db/post/0014_*.sql`, `0015_*.sql` (+ journal),
`packages/db/src/background/` (two definitions, index), `packages/db/src/schema/chat.ts`,
`packages/db/src/schema/project-search.ts`, `packages/db/optional/` (removed),
`apps/api/src/lib/fold.ts`, `apps/api/src/services/thread-search.ts`,
`apps/api/src/services/thread-history.ts`, `apps/api/src/services/threads.ts`
(callers of the fold), `apps/api/src/services/project-search/retrieval.ts`,
tests under `apps/api/src/__tests__/{unit,live}/`, `tools/upgrade-test` (if its
checks need the new step), `docs/OPERATIONS.md`, `docs/dev/database.md`,
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
  (column untouched), NULL when no foldable letter, and a write through each
  distinct shape of the twelve update paths (at least one per service).
- **Switch-over:** live tests that search uses the exact path while the
  backfill or the step is unfinished, and the folded path after; that a row
  written mid-backfill is folded once (trigger) and found once.
- **Parity:** on generated text in several languages, the new path returns
  everything the old path returned, plus the accent matches.
- **Upgrade:** the rolling-upgrade test from v0.12.1 under load.
- **Scale:** the harness measurements above.

## Boundaries (module-specific)

- **Always:** keep `message_text_search_idx` and the exact path (the previous
  release uses them; rollback needs them; they answer unaccented text);
  keep the trigger cheap (no work when `parts` is unchanged).
- **Ask first:** a stored generated column or anything that rewrites
  `message` or `project_file_chunk`; requiring the backfill in
  `releases.json` (that belongs to the release that removes the exact path).
- **Never:** make an upgrade wait for the backfill or a slow index build;
  depend on an extension (`unaccent`).

## Success criteria

The acceptance criteria hold; #362 is closed; the rolling-upgrade test
passes from v0.12.1; the measurements are recorded.

## Decisions (2026-10-12)

1. **Disk:** store the folded vector only where folding changes the text,
   with a partial index, and match the folded query against the exact and the
   folded index (recommendation 1 of the draft, adopted). Extra disk is used
   only by text with foldable letters.
2. **The optional index:** dropped in v0.13 (adopted).
3. **One IMMUTABLE SQL function** `oci_fold_search_text(text)` (adopted).
   Rule for `docs/dev/database.md`: because the vectors are stored, any change
   to the fold needs a background migration that recomputes `search_folded`.
4. **Project chunks need no index** (found while writing the plan: keyword
   search never uses the GIN index on a materialized per-project scope), which
   removes one post-deploy step from the draft.

## Open questions

None.
