# Implementation Plan: v0.13 (search, backups and scale)

Specs: [SPEC.md](../SPEC.md) (index and decisions), one `SPEC-<module>.md` per
module. Tasks: [todo.md](todo.md). The v0.12.1 plan (`release-hygiene`) is in
`tasks/done/`.

## Overview

Four tracked pieces, in the order that earns the most for the least risk:

1. **Chart gap #385** (small, independent): done first because it is what
   left post-deploy steps unapplied on the cluster.
2. **`accent-search` (#362)**: the user-visible fix, and the only module that
   adds migrations (0047 to 0049) and post-deploy steps (0014 to 0016).
3. **`external-backups` (#386)**: independent of search; needs its own spec,
   drafted in parallel while accent-search builds.
4. **`scale-on-cluster` (#387)**: last, because it measures accent-search's
   new search at the `large` profile.

## Architecture decisions

- **One person adds migrations at a time** (SPEC.md): accent-search first;
  external-backups prefers no migration.
- **accent-search: stored folded vector, set only where folding changes the
  text** (partial index; search matches the folded query words against both
  the exact index and the folded one). See SPEC-accent-search.md.
- **`RUN_POST_MIGRATIONS=auto`** (#385) uses the replica heartbeat's release
  as the signal that every replica is current, and needs Redis.
- **Releases:** the chart fix and accent-search ship together as v0.13.0 with
  the other modules that are ready; backups and scale may follow as v0.13.x
  if they are not.

## Task list

### Phase 1: Chart gap (#385)
- [x] Task 1: `RUN_POST_MIGRATIONS=auto`, the chart, tests, docs

### Checkpoint A
- [ ] Coverage, checks, chart CI green; merged to `main`

### Phase 2: accent-search (#362), on branch `v0.13/accent-search`
- [x] Task 2: One fold: SQL function `oci_fold_search_text` (migration 0047), `ß æ œ`, the TypeScript fold, titles and every `foldSql` caller on it
- [ ] Task 3: Messages: `search_folded` column and trigger (0048), background migration `0.13.message-search-folded`, post step 0014 (partial GIN), search switches when both are done
- [ ] Task 4: Project file chunks: the same (0049, `0.13.chunk-search-folded`, post step 0015)
- [ ] Task 5: Remove the optional index (file, code, tests), post step 0016 drops it if built; docs rewritten

### Checkpoint B
- [ ] Coverage, checks, migration lint, `node tools/upgrade-test/run.mjs --from v0.12.1` pass; EXPLAIN shows both indexes used
- [ ] Measurements on the scale harness `small` recorded

### Phase 3: external-backups (#386): spec approval, then tasks (to be planned)
- [ ] Task 6: Spec reviewed and approved

### Phase 4: scale-on-cluster (#387): spec, then tasks (to be planned)
- [ ] Task 7: Spec written, reviewed and approved

### Checkpoint C: v0.13.0 released

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The trigger slows message inserts | Medium | It does nothing unless the text has foldable letters; measured on `small` |
| The backfill loads a busy database | Medium | The v0.11 framework throttles on replication lag and long transactions; batch size and pause are tunable |
| Search returns different results once ready | High | Parity tests: the new path returns the old path's results plus the accent matches, on generated data in several languages |
| An old replica writes during the upgrade | Medium | A trigger, not application code, so every writer is covered |
| `auto` applies steps while an old replica serves | High | It requires every heartbeating replica to report this release and waits otherwise (tested) |

## Open questions

Accent-search's three questions are settled (SPEC-accent-search.md,
"Decisions"). Backups and scale: in their specs.
