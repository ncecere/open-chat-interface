# Spec: external-backups

Module of [SPEC.md](SPEC.md) (v0.13). Depends on nothing. **Status: draft.**
Shared commands, structure, style, testing and boundaries are in SPEC.md; this
file adds what is specific to this module. No migration: the build order's
"one adds migrations at a time" is not affected.

## Objective

OCI's scheduled backup always dumps the database: `performBackup` calls
`dumpDatabase` (`apps/api/src/services/backups/run.ts:95`), one
`pg_dump --format=custom` on a control connection that holds a transaction open
for the whole dump (`dump.ts`, `docs/OPERATIONS.md:322`), then reads the archive
back through `pg_restore --list` (`run.ts:159`, `verifyDump`). On a large
cluster this takes hours and loads the primary, and background migrations wait
for such a transaction (`docs/OPERATIONS.md:717`, `:753`). It also ties backups
to the client tools in the API image, which are PostgreSQL 17
(`docker/api.Dockerfile:53`): per `AGENTS.md`, backups against a `dev-env`
PostgreSQL 18 server do not work.

Clusters with their own backups (CloudNativePG, pgBackRest, WAL-G, point-in-time
recovery) do not want that dump. This module adds an **external database
backup** mode:

1. **A setting, `databaseBackup: 'dump' | 'external'`**, in the existing
   `backups` instance setting. Default `dump`: nothing changes on upgrade.
2. In `external` mode a run still builds the attachment manifest, copies
   attachment files to `objects/<sha256>`, reads them back, applies retention
   and sweeps unreferenced copies, on the same schedule. It does not run
   `pg_dump` or `pg_restore`.
3. **System health** gets a row for the database's recovery-related state, read
   with SQL (`pg_stat_archiver` and three settings), and says in every state
   that OCI cannot tell whether the external backup restores.
4. **Documentation**: recovery objectives per approach, guides for CloudNativePG
   and pgBackRest (WAL-G short, documented only), what else to back up, and a
   restore drill with a checklist that proves OCI works after a restore.
5. **Tests**: live tests for the mode and for archiver state against a
   PostgreSQL 17 with archiving on; a weekly pgBackRest point-in-time restore
   drill in Docker; a CloudNativePG drill on `dev-env` by hand. CI cannot run
   CloudNativePG (see Testing strategy).

Users: operators of clusters with their own backups; administrators (the
Backups page, System health); developers on `dev-env` (backups that work against
PostgreSQL 18).

**Not in this module:**
- OCI does not trigger, configure or inspect CloudNativePG, pgBackRest or
  WAL-G, does not call the Kubernetes API, and installs nothing in the image.
- OCI does not restore the database. The restore is the operator's tooling.
- No endpoint for operator tooling to push a "backup finished" timestamp (Open
  question 2).
- The format of dump-mode backups and `backup:restore-files` do not change.
- The homelab's manifests (`~/homelab/bitop-talos`).

## Acceptance criteria

### 1. The mode: setting, upgrade, behaviour
- `StoredBackupSettings` (`apps/api/src/services/settings.ts:273`) gains
  `databaseBackup?: 'dump' | 'external'` and `walArchivingExpected?: boolean`
  (criterion 2). Absent means `dump` and `true`. The shared schemas
  (`backupSettingsSchema`, `updateBackupSettingsSchema`,
  `packages/shared/src/schemas/operations.ts:68`, `:98`),
  `normalizeBackupSettings` (`settings.ts:55`), `toPublicBackupSettings`
  (`:74`) and `changedBackupFields` (`:109`) carry them. The mode is therefore
  audited as `backup.settings.update` (`fields` lists `databaseBackup`; no
  credential), and `backup.run` metadata says `database: 'external'` and has no
  `dumpBytes`.
- **No migration, no column.** The setting is JSON in `instance_setting.value`.
  `getSetting('backups')` returns the stored object unnormalised and
  `updateSetting` merges (`settings.ts:400-423`), so a v0.12 replica that saves
  other backup fields during a rolling upgrade keeps the new keys (a live test
  proves it). Same precedent as `copyFiles` (`normalizeBackupSettings`, v0.10).
- **No surprise on upgrade.** An instance with any stored backup settings, or
  none, is `dump` after upgrading. The mode is never inferred from
  `archive_mode` or anything else OCI reads. Only an administrator's PATCH
  changes it.
- **What an `external` run does:** manifest, file copies when
  **Copy attachment files** is on, read-back of the manifest and of files
  (`verifyFiles`), `manifest.json`, retention (`pruneBackups`), sweep
  (`sweepCopies`), the `backup.run` audit entry and the `oci_backup_*` metrics,
  scheduled and manual alike. `manifest.json` keeps `format: 'oci-backup/1'` and
  has `database: { external: true }` in place of `key`, `bytes`, `sha256`
  (`run.ts:133`). `backup_run.dump_*` stay NULL. The verification detail reads
  "Database: backed up outside OCI, not checked by OCI; N attachment objects
  checksummed; ...".
- **What it does not do:** spawn `pg_dump` or `pg_restore`, open a control
  connection for a dump (`run.ts:100`), or need the client tools. The refusals
  "pg_dump was not found" at `routes/admin/backups.ts:40` and
  `status.ts:90` apply in `dump` mode only; the page shows "PostgreSQL client
  tools: not needed" (`apps/web/src/routes/admin/backups.tsx:121`).
- **Restore from an external run:** `backup:restore-files` works unchanged: it
  reads only `files.copied` and `attachments.jsonl`
  (`restore-files.ts:88`). The database comes from the operator's tooling.
- **Retention and the sweep keep their meaning**, and the docs and the page say
  what it now implies: copies are kept while a retained manifest lists them
  (`pruning.ts:75`), so **days kept must be at least the database recovery
  window**, or a recovery point inside the window can need an attachment the
  sweep already deleted. Switching modes deletes nothing: dumps from earlier
  runs expire by retention as today (`pruneBackups` skips a NULL `dumpKey`).
  OCI only ever deletes objects under its own backup root.
- **Choosing external** asks for confirmation in the page: "OCI will stop
  dumping the database. Check that your own backups work: OCI cannot." With
  **Copy attachment files** off it is allowed; the page says plainly that OCI then
  backs up nothing but a checksum list.
- **Rolling back to v0.12 or earlier** ignores the setting and starts dumping
  again at the next slot. The upgrade note says to turn automatic backups off
  first if that is not wanted.
- Compliance export shares `destinationIssues` and `resolveDestination`
  (`services/backups/settings.ts`, `services/compliance/settings.ts:7`); both
  keep working unchanged. No new deletion path is added under
  `services/backups/`, which `legal-hold-paths.unit.test.ts:216` skips.

### 2. Verification without a dump, and System health
OCI verifies what it can read. With `databaseBackup: 'external'`, System health
shows a second row, **Database backup (external)**, from one read-only query on
the application pool (the primary):

```sql
select current_setting('archive_mode'), current_setting('wal_level'),
       current_setting('archive_timeout'), pg_is_in_recovery(), a.*
from pg_stat_archiver a;
```

OCI never reads `archive_command` (it can carry credentials), never needs a
privilege beyond an ordinary application role (a live test connects as one),
never needs Kubernetes access, and shows WAL file names only. If any read is not
permitted the row says what could not be read and is a warning, never an error
(OCI cannot tell).

| What OCI reads | Status | Row says |
| --- | --- | --- |
| Connected to a standby (`pg_is_in_recovery()`) | warn | `DATABASE_URL` names a standby; point it at the primary. |
| `archive_mode = off` or `wal_level = minimal`, archiving expected | warn | WAL archiving is off, so point-in-time recovery is not possible from this server. |
| Same, `walArchivingExpected` set to false | ok | WAL archiving is off, as configured (snapshot-style backups). |
| `last_failed_time` later than `last_archived_time`, last success over 15 minutes ago or none | **error** | WAL archiving is failing since `<time>` (`<wal file>`); WAL piles up on the primary's disk and recovery points stop advancing. |
| Failing, but a success within 15 minutes | warn | A recent archive attempt failed; retrying. |
| `archive_timeout > 0` and no success for `max(3 x archive_timeout, 15 min)` | warn | No WAL archived for `<n>`; expected at least every `<archive_timeout>`. The server may be idle. |
| `archive_timeout = 0` | (no staleness judgement) | Says so: an idle server can go long between segments. |
| Archiving works | ok | Last segment `<wal file>` archived `<time>`; `<count>` archived since `<stats_reset>`. |

Every state ends with the same sentence: **"Not verified by OCI: that a base
backup exists, is recent, or restores. Run the restore drill."** The row is red
only for an archiver that is failing now: the one condition OCI can see that
harms the primary (full WAL disk) and ends recoverability. It is never green on
"the backup is good".

Not read: replica lag (`pg_stat_replication` needs `pg_monitor` or
`pg_read_all_stats`, which an application role lacks); base backup age and
snapshot state (in the operator's tooling; Open question 2).

- The existing **Backups** row keeps its rules (`health-checks.ts:33`) and
  words its summary "database backed up outside OCI" instead of
  "0.0 KB database" (`:80`). The new row shows whenever the mode is `external`,
  also while **Back up automatically** is off.
- Metrics, registered only in `external` mode
  (`services/observability/collected.ts`):
  `oci_wal_archive_last_success_timestamp_seconds` (absent when none) and
  `oci_wal_archive_failing` (0 or 1). `docs/admin/observability.md` gets an
  alert example. `oci_backup_last_success_timestamp_seconds` keeps meaning
  "the attachment backup".
- The Backups page prints "0 B database" for a run without a dump
  (`backups.tsx:335`); it shows attachment counts only. Retention fields get a
  hint about the recovery window.

### 3. Documentation
New `docs/admin/external-database-backup.md`, linked from `backups.md`,
`docs/admin/README.md` and `docs/OPERATIONS.md` ("Back up"). It covers:

- **What OCI does and does not do** in this mode.
- **Recovery objectives**, stated per approach, with what each depends on, and
  no number the repository has not measured:

  | Approach | Database RPO | Database RTO |
  | --- | --- | --- |
  | OCI `pg_dump` (today) | Up to 24 h (daily slot) plus the run time | Download and serial `pg_restore` (no `--jobs`: the archive is written to a stream, `backups.md`); hours at `large`, not measured |
  | CloudNativePG, WAL archive + base backups (Barman Cloud plugin) | CloudNativePG documents ≤ 5 min with WAL archiving (`archive_timeout` 5 min) | Restore the base backup (an object store restore is a full copy) plus WAL replay; volume snapshots restore faster on very large databases |
  | CloudNativePG, volume snapshots only | The snapshot interval, unless WAL is also archived | Fast; snapshot class dependent |
  | pgBackRest, WAL archive + backups | Set by `archive_timeout` (the guide says to set it, for example 60 s); with `archive-async`, WAL not yet pushed is lost with the node | `restore` with `process-max` and `--delta`, plus WAL replay |
  | WAL-G | As pgBackRest | As pgBackRest |

  Attachments, in every approach: **RPO up to one schedule interval (24 h)** for
  files uploaded since the last run, which a database restored to a later time
  still references; **RTO** is `backup:restore-files` at the link speed between
  bucket and storage. The objective for OCI is the worse of the two. Versioning
  on the attachment bucket is how to reduce the attachment RPO. The drill is how
  to measure both RTOs (a table to fill in).
- **CloudNativePG guide.** The in-tree `barmanObjectStore` has been deprecated
  since CloudNativePG 1.26 in favour of the Barman Cloud Plugin (CloudNativePG
  1.28 docs), so the guide leads with the plugin: `ObjectStore`, the `Cluster`
  `.spec.plugins` entry with `isWALArchiver: true`, `Backup` and
  `ScheduledBackup` (`method: plugin`; six-field cron with seconds), retention,
  and PITR: a new `Cluster` with `bootstrap.recovery` and
  `recoveryTarget.targetTime`, plus enabling archiving on the restored
  cluster. It also names the in-tree form (for clusters not yet migrated) and
  volume snapshots, and warns that on-demand backups do not include the
  Kubernetes Secrets. `DATABASE_URL` must name the `-rw` service, not `-ro`.
- **pgBackRest guide.** Repository and `pgbackrest.conf`, `stanza-create`,
  `archive_mode = on` with `archive_command = 'pgbackrest --stanza=<name>
  archive-push %p'`, `archive_timeout`, `check`, `backup`, retention
  (`expire`), `verify`, and PITR with `restore --type=time --target=...
  --target-action=promote` (`--delta`). Notes: the repository cipher
  passphrase is as critical as `ENCRYPTION_KEY`; an example Docker image for
  Compose users (`pgvector/pgvector:pg17` plus the package) that OCI does not
  ship.
- **WAL-G**: one short section, labelled documented only and untested here:
  the same shape as pgBackRest and the same RPO logic.
- **What else must be backed up:** `ENCRYPTION_KEY` and, if rotated within the
  database recovery window, the previous keys (`docs/OPERATIONS.md:540`:
  "older database backups still need it"; a PITR point before a rotation is
  one); `AUTH_SECRET`; the Kubernetes Secrets and `DATABASE_URL` credentials;
  the object storage credentials; the backup bucket (attachment copies); the
  external backup's own credentials (CloudNativePG `ObjectStore` secret,
  pgBackRest cipher passphrase).
- **Compliance note** (also one line in `docs/admin/compliance.md:281`): erased
  data stays in the operator's database backups until they expire, and OCI
  neither sees nor deletes them.
- **The restore drill**, a procedure, then a checklist.
  1. Pick a scratch place: a scratch namespace (on the homelab only `dev-oci`,
     never production, `AGENTS.md`) or a Compose project. Never production
     credentials.
  2. Restore the database to a time T with the operator's tooling.
  3. Restore attachments: `backup:restore-files` (`--dry-run` first) from the
     newest run at or before T **and** the oldest at or after T (existing
     objects are left alone, so both can be applied). Files uploaded after the
     chosen run have no copy: that is the attachment RPO.
  4. Give the scratch OCI the same `ENCRYPTION_KEY` (and previous keys) and
     `AUTH_SECRET`.
  5. Start it with **`OCI_ROLE=web` only, no worker.** The restored database
     carries the production `backups` setting: with `enabled`, a worker would
     back up into the production bucket and run the sweep, which deletes copies
     the restored database's runs do not list (`run.ts:317`, `pruning.ts:75`).
     It would also send webhooks and compliance exports. (`backups.md`
     "Restoring" step 4 says nothing of this today; it is fixed here.)
  6. Checklist: migrations apply (`pnpm upgrade:check`, then startup); an
     administrator signs in (`AUTH_SECRET`); a provider's **Test** passes
     (`ENCRYPTION_KEY`); System health shows no error except "no background
     worker"; **Check for orphans** (`docs/admin/operations.md:222`) reports
     records with no object = 0, or each one explained as uploaded after the
     chosen run; a conversation with an attachment opens and the download's
     SHA-256 equals its `attachments.jsonl` line; rows written before T are
     present and rows after T are absent.
  7. Record: time to a working database, time to restore attachments, T, the
     chosen runs; compare with the objectives. Repeat quarterly and after any
     change to backup configuration or PostgreSQL major version. Tear the
     scratch environment down.
- Edits elsewhere: `backups.md` (the mode; "Restoring" step 4), `OPERATIONS.md`
  "Back up" (`:465-503`), `docs/admin/operations.md:26` (health table),
  `observability.md`, `CHANGELOG.md` (Added; **Upgrade note**: default
  unchanged; rolling back), `ROADMAP.md`, `docs/dev/restore-drill.md`.

### 4. Gates
- Tests, drills and floors as under Testing strategy, zero skips. The
  CloudNativePG drill on `dev-env` runs once for this module and before any
  release that touches backups; its times go in `docs/dev/restore-drill.md`.
- The rolling-upgrade test from v0.12.1 passes with a stored `external`
  setting; `pnpm lint:migrations` is unchanged and clean.
- UI: web unit tests and e2e pass; QA screenshots of the Backups page (both
  modes) and System health are read before merging; the branch is checked on
  `dev-env` (health, sign-in, Backups in external mode) and taken down.

## Files touched (expected)

API and shared: `packages/shared/src/schemas/operations.ts`,
`apps/api/src/services/settings.ts`, `services/backups/{settings,run,status}.ts`,
`services/backups/database-state.ts` (new: the archiver read, the rules, the
row), `routes/admin/backups.ts`, `routes/admin/health.ts`,
`services/observability/{health-checks,collected}.ts`.

Web: `apps/web/src/routes/admin/backups.tsx`,
`tests/unit/admin-backups.test.tsx`.

Tests: `apps/api/src/__tests__/unit/backups-database-state.unit.test.ts`,
`__tests__/live/backups-external.live.test.ts`,
`__tests__/live/backups-archiver.live.test.ts`,
`apps/api/test/live-archive-postgres.ts` (helper; `TEST_ARCHIVE_DATABASE_URL`),
`apps/api/vitest.config.ts` (floor), `.github/workflows/ci.yml` (archive-enabled
PostgreSQL step and variable). The first four are new files.

Drill: `tools/restore-drill/` (new: `run.mjs`, `compose.yaml`, `Dockerfile`,
`README.md`), `.github/workflows/restore-drill.yml` (new; weekly and manual,
builds locally, publishes nothing, as `failover-drill.yml`).

Docs: `docs/admin/external-database-backup.md` (new), `docs/admin/backups.md`,
`docs/admin/README.md`, `docs/admin/operations.md`, `docs/admin/observability.md`,
`docs/admin/compliance.md`, `docs/OPERATIONS.md`, `docs/dev/restore-drill.md`
(new), `CHANGELOG.md`, `ROADMAP.md`, `SPEC.md` (map row).

Outside the repository: `~/.oci-harness/compose.yaml` needs the same
archive-enabled PostgreSQL as CI (ask first; SPEC.md says the harness mirrors CI).

## Commands (module-specific)

```sh
python3 $H/run.py test external-backups \
  src/__tests__/unit/backups-database-state.unit.test.ts \
  src/__tests__/live/backups-external.live.test.ts \
  src/__tests__/live/backups-archiver.live.test.ts
python3 $H/run.py test backups-regression \
  src/__tests__/live/backups-dump.live.test.ts \
  src/__tests__/live/backups-files.live.test.ts \
  src/__tests__/live/backups-admin.live.test.ts \
  src/__tests__/live/backup-health-off.live.test.ts
python3 $H/run.py web tests/unit
node tools/restore-drill/run.mjs          # Docker; the weekly workflow runs it
node tools/upgrade-test/run.mjs --from v0.12.1
pnpm lint:migrations && pnpm release:check
```

## Testing strategy

Every test is written first and fails on today's code (there is no setting, so
an external run still spawns `pg_dump`).

- **Unit:** the rules table of criterion 2, one case per row, with the clock
  injected (a standby, a failing archiver with and without a recent success,
  `archive_timeout` 0, a NULL `last_archived_time` after a statistics reset,
  an unreadable setting); settings normalisation and the audited field list.
  The standby row is unit-only: CI has no standby.
- **Live, in the harness (PostgreSQL 17, S3, no archiving):**
  `backups-external.live.test.ts` runs an external backup with the `spawn` spy
  of `backups-dump.live.test.ts:60` and `BACKUP_PG_BIN_DIR` pointing at an empty
  directory: no `pg_dump` or `pg_restore` is started, the run succeeds, the
  manifest says `database.external`, files are copied and read back, a
  corrupted copy fails the run, retention and the sweep behave as in dump mode,
  `backup:restore-files` restores from it, switching modes leaves earlier dumps
  to retention, a legacy stored setting is `dump`, and a v0.12-style save keeps
  the new keys. The dump-mode live tests pass unchanged.
- **Live, needs PostgreSQL with archiving:** `backups-archiver.live.test.ts`
  against a second PostgreSQL 17 started with `wal_level=replica`,
  `archive_mode=on`, `archive_timeout`, and
  `archive_command='test ! -f /archive/%f && cp %p /archive/%f'` (the
  PostgreSQL manual's example) on a local directory. As superuser the test
  forces a segment switch (`pg_switch_wal()`), and OCI's read, connecting as a
  non-superuser role, sees `archived_count` rise and `last_archived_wal` exist
  in the directory (`pg_ls_dir`). It then sets `archive_command = 'false'`
  (`ALTER SYSTEM`, `pg_reload_conf()`), switches again, and sees `failed_count`
  rise and the row go to error with the clock moved past 15 minutes; restores
  the command and sees it recover. Against the normal harness PostgreSQL
  (`archive_mode=off`) the row warns. **How CI gets one:** GitHub Actions
  service containers take no server arguments (to confirm when implementing),
  so `ci.yml` starts it with a `docker run` step (`pgvector/pgvector:pg17`,
  port 5440, a mounted directory) before the tests, and the harness compose
  gains the same service (15440). As `liveS3Available` does
  (`apps/api/test/live-backup-tools.ts`), an unset `TEST_ARCHIVE_DATABASE_URL`
  is an error in CI, not a skip.
- **Web unit:** the confirmation, "not needed" for client tools, no "0 B
  database", the retention hint, the audited PATCH body.
- **pgBackRest drill (weekly, `tools/restore-drill`):** Docker only. A
  `pgvector/pgvector:pg17` image with pgBackRest and a local repository;
  `stanza-create`, `check`, a full backup; OCI's migrations, fixture rows and
  attachments on VersityGW; an OCI external backup; more writes, then a
  recorded target time T, then more writes and a segment switch; stop; `restore
  --type=time --target=T --target-action=promote` into a fresh data directory;
  start. It asserts: rows before T present and after T absent, OCI starts as
  `OCI_ROLE=web` and migrates cleanly, `backup:restore-files` restores every
  copy, **Check for orphans** finds no record without an object for files
  uploaded before the chosen run, and it prints the two restore times. Run by
  `workflow_dispatch` while developing the module, then on the weekly schedule.
- **CloudNativePG drill (`dev-env`, by hand):** the guide's steps in
  `dev-oci`: a `Cluster` with the Barman Cloud plugin and an in-namespace
  S3-compatible server if `dev-env` has none, a `Backup`, writes, a recovery
  `Cluster` at T, then criterion 3's checklist against the branch's images.
  Times go in `docs/dev/restore-drill.md` as an example, not a promise.
- **What CI proves:** OCI reads the archiver and words each state correctly
  (including as an unprivileged role); external mode never dumps and still
  backs up and verifies attachments; the setting survives upgrade and rolling
  upgrade; a pgBackRest point-in-time restore of an OCI database yields a
  working OCI with its attachments, weekly.
- **What CI cannot prove:** that a CloudNativePG cluster restores (needs
  Kubernetes, the operator and the plugin; only the `dev-env` drill, by hand);
  that the manifests in the guides match the operator version in use; that an
  operator's real backups are healthy; restore time at `large` (the drill gives
  an example at small size). A CloudNativePG-on-`kind` workflow (as `helm.yml`
  uses `kind`) was considered and not proposed: operator, plugin and object
  store downloads in every run are a heavy, flaky dependency.
- **Coverage floors** (`apps/api/vitest.config.ts`): new
  `src/services/backups/database-state.ts` at 95 / 85 / 100; the existing floors
  for `run.ts` (87/70/82), `settings.ts` (93/88/90), `files.ts`,
  `restore-files.ts`, `routes/admin/backups.ts` and `pg-tools.ts` hold, so the
  new branches in `run.ts` and `settings.ts` need their tests. No floor
  exists for `health-checks.ts`; the new logic lives in `database-state.ts` for
  that reason.

## Boundaries (module-specific)

- **Always:** `dump` stays the default; the row says "Not verified by OCI" in
  every external state; OCI deletes only objects it wrote under its own backup
  root; the new reads stay read-only on the application pool.
- **Ask first:** any change to the dump format, `pg_dump` arguments,
  `restore-backup-files` behaviour, or `manifest.json` beyond adding
  `database.external`; a push endpoint or any new credential type; any tool or
  dependency in the API image; the `ci.yml` step and the restore-drill workflow;
  changing `~/.oci-harness`; anything in `~/homelab/bitop-talos` (installing the
  Barman Cloud plugin, an object store for `dev-env`); running the CloudNativePG
  drill on the cluster.
- **Never:** delete, alter or list for deletion anything in an operator's
  external backup storage (OCI holds no credentials for it); call the
  Kubernetes API; read `archive_command`; print `DATABASE_URL`, S3 secrets,
  a pgBackRest cipher passphrase or Kubernetes Secret contents in logs, health
  text, audit metadata or docs examples; run a drill in the `open-chat-interface`
  namespace, with production credentials, or with a worker pointed at the
  production backup bucket; say or imply that an external backup is restorable.

## Success criteria

All acceptance criteria above hold, every command in SPEC.md and this file
passes, the pgBackRest drill has run green on its schedule, the CloudNativePG
drill has been run once with its times recorded and its environment taken down,
`SPEC.md`'s map row is marked done, and the change is released in **v0.13.0**
(SPEC.md, decision 1) by `docs/RELEASING.md`.

## Open questions

1. **How far does "tested" go?** Decision 3 says CloudNativePG and pgBackRest
   are tested. Proposed: pgBackRest by the weekly Docker drill; CloudNativePG by
   a hand-run `dev-env` drill, not CI. *Recommendation: accept.* The alternative
   (operator and plugin on `kind` in CI) costs more than it proves.
2. **A pushed freshness signal?** Without it OCI cannot see that base backups
   stopped (a suspended `ScheduledBackup`, a failing pgBackRest cron): WAL keeps
   archiving while the oldest base backup eventually expires. *Recommendation:
   not in v0.13.* OCI has no token type for it (`METRICS_TOKEN`,
   `config/env.ts:78`, only guards metrics), a pushed timestamp is an assertion
   OCI cannot check, and the operator's Prometheus sees both tools directly. The
   docs give those alerts (CloudNativePG's backup metrics, the plugin's
   `barman_cloud_cloudnative_pg_io_last_available_backup_timestamp`, pgBackRest
   `info --output=json`). Revisit if operators ask.
3. **`walArchivingExpected`** (default true) lets snapshot-only clusters turn
   the "archiving is off" warning into ok. *Recommendation: include it*; the
   alternative is a permanent warning for a valid setup, or a silent "ok" for
   an invalid one.
4. **Attachment schedule.** Daily only, so attachment RPO is up to 24 h.
   *Recommendation: keep daily*; each run pages the whole attachment table
   (`manifest.ts:147`). Revisit an hourly files-only schedule once
   `scale-on-cluster` measures that cost; versioning on the attachment bucket is
   the documented remedy meanwhile.
5. **CloudNativePG on the homelab.** The guide leads with the Barman Cloud
   plugin (the in-tree form is deprecated since 1.26), and the repository does
   not say which version or plugin `dev-env` has. *Recommendation:* confirm
   with `tools/dev-env/README.md` before the drill; if the plugin is missing,
   run the drill on the in-tree form and say so; installing the plugin is a
   homelab change (ask first).
6. **External with copying off.** Allowed, with a plain notice, as copying off
   is today. *Recommendation: allow*; refusing would force a large first copy
   on someone who protects attachments with bucket versioning.
