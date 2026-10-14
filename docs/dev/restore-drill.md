# Restore drill

An external database backup ([admin guide](../admin/external-database-backup.md))
is only as good as its last restore. This page is for developers: what the two
drills of issue #386 do, what they prove and what they cannot, how to run them,
and the times they measured. The operator's procedure and checklist are in the
[admin guide](../admin/external-database-backup.md#the-restore-drill); the
drills follow it.

| Drill | Where | When | What restores |
| --- | --- | --- | --- |
| pgBackRest | Docker, `tools/restore-drill` | Weekly (`.github/workflows/restore-drill.yml`, Tuesdays 05:30 UTC) and on demand | A real pgBackRest repository, real PostgreSQL 17 with pgvector, real S3 (VersityGW) |
| CloudNativePG | The `dev-oci` namespace, by hand | Once for this module, and before any release that touches backups | A CloudNativePG cluster with the Barman Cloud plugin |

## The pgBackRest drill

```bash
node tools/restore-drill/run.mjs
```

[tools/restore-drill/README.md](../../tools/restore-drill/README.md) has the
options, the files and one line per check. In short:

1. A PostgreSQL 17 + pgvector + pgBackRest container archives WAL to an
   encrypted local repository. `stanza-create`, `check`, a full backup.
2. OCI (built from the checkout, `OCI_ROLE=all`) migrates, and gets a provider,
   a person, conversations and attachments on S3 and
   `databaseBackup: 'external'`. Run **R1**. More writes, the target time **T**,
   more writes, run **R2**, and a WAL segment switch that is waited for until it
   is archived.
3. The primary, its data volume and the attachment bucket are destroyed. The
   pgBackRest repository and the backup bucket are what is left.
4. `pgbackrest restore --type=time --target=T --target-action=promote` into a
   fresh volume; a second PostgreSQL replays WAL to T and promotes.
5. OCI starts on it as `OCI_ROLE=web` (no worker); `backup:restore-files` runs
   from R1, then R2; the checks of the admin guide run.

### What it proves

- A point-in-time restore from a real pgBackRest repository yields an OCI
  database that migrates cleanly (`upgrade-check`, `migrate`) and starts. Rows
  written before T are present and rows written after T are absent: conversations,
  attachment records and the `backup_run` history.
- OCI in `external` mode writes no dump (`dump_*` are NULL, the manifest says
  `database.external`, no `database.dump` is in the bucket) and still copies and
  reads back attachments.
- The restored OCI has working credentials: with the same `ENCRYPTION_KEY` a
  stored provider key decrypts and the stored S3 secret is usable.
- The two-run attachment procedure works as the guide says. After restoring from
  the newest run at or before T alone, **Check for orphans** reports a record
  without an object (a file uploaded after that run: the attachment RPO); after
  also restoring from the oldest run at or after T it reports none.
  Every restored attachment downloads with the SHA-256 of its `attachments.jsonl`
  line, and a conversation that carries an attachment opens.
- A restored database that says "backups on" does nothing at the backup
  destination when it runs without a worker: the backup bucket is as it was
  (every key and size), and no run starts.

The reason for the web-only rule was checked once by hand, not by the drill: a
worker (`OCI_ROLE=worker`) started on the restored database ran a scheduled
backup at its first tick, 10 minutes after it started, and wrote a new run folder
into the backup bucket. The sweep did not delete anything then, because it
deletes only copies at least a day old (`SWEEP_GRACE_MS`); on a restore made
days after the runs it would.

### What it cannot prove

- That a CloudNativePG cluster restores: that needs Kubernetes, the operator and
  the plugin (the by-hand drill below), and that the manifests in the guide match
  the operator version in use.
- That WAL-G works. It is documented, not tested.
- That an operator's real backups are healthy, or restore time at production
  size. The numbers below are from a small database on a laptop.
- A pgBackRest repository on object storage, remote repository hosts, or
  `archive-async`. The drill's repository is a local directory on a volume.

### Choices that are not obvious

- **R1 is aged by one day** in `backup_run` (an `UPDATE` of `started_at` and
  `finished_at`; its objects and manifest are untouched). Retention keeps the
  newest run of each UTC day and OCI runs once a day, so two runs of one drill
  would otherwise cost R1 its objects. This also leaves today's schedule slot
  uncovered in the restored database, so a worker would back up there at once;
  that is the case the web-only start has to survive. The source's own scheduler
  first ticks 10 minutes after the API starts, which the drill finishes inside.
- **Archiver failures before `stanza-create`** are expected: PostgreSQL starts
  archiving before the stanza exists. The check is that the archiver is not
  failing at the end, as System health judges it.
- **`BACKUP_PG_BIN_DIR=/nonexistent`** in the OCI containers: any attempt to run
  `pg_dump` in external mode fails loudly.
- **The restored server has no archiving flags** and the restore passes
  `--archive-mode=off`: a scratch copy must not push WAL into the repository it
  came from. The guide says the same.

### Measured times (an example, not a promise)

One run on a laptop (Apple silicon, Docker Desktop, 12 CPUs and 8 GB for the
VM), PostgreSQL 17, pgBackRest 2.59.3, a database of OCI's schema with a few
dozen rows, five attachments of about 96 KiB. The restore time of a real
database is dominated by its size and by the link to the repository; these
numbers say how long the steps take on an empty one.

| Step | Seconds |
| --- | --- |
| Full backup of the empty database (before OCI had a table) | 1.5 |
| `pgbackrest restore` into a fresh volume | 0.8 |
| Recovery to T and promotion | 0.9 |
| **Time to a working database** (the restore began until the restored server is the primary) | 1.7 |
| Attachments: a dry run, the restore from R1, the restore from R2 and two **Check for orphans** (each restore starts a container, which is most of this) | 1.8 |
| The whole drill, after the image build | 42 |

Of the 42 seconds most is OCI starting, migrating and running its two backups.
The weekly workflow's report has the same table for the runner.

Measure yours with the drill's table in the
[admin guide](../admin/external-database-backup.md#the-restore-drill).

## The CloudNativePG drill (by hand, on `dev-env`)

Not run in CI: it needs Kubernetes, the CloudNativePG operator and the Barman
Cloud plugin, and a CloudNativePG-on-`kind` workflow was considered and not
proposed (operator, plugin and object store downloads in every run are a heavy,
flaky dependency). Run it once for this module, and before a release that touches
backups. **Only in `dev-oci`, never in `open-chat-interface`** (see
[AGENTS.md](../../AGENTS.md)). Anything installed in the cluster (the plugin, an
object store) is a change to `~/homelab/bitop-talos`: ask first.

### Before you start

1. Read `tools/dev-env/README.md` in the homelab checkout and the cluster:
   which CloudNativePG version is installed (the plugin needs 1.26 or newer and
   cert-manager), and whether the Barman Cloud plugin is installed in the
   operator's namespace. This repository does not say. **If the plugin is
   missing, run the drill on the in-tree `barmanObjectStore` form and say so in
   the record**; installing the plugin is a homelab change.
2. `dev-env` has no S3 server for `oci` environments (its S3 template belongs
   to the `grounded` project). The drill needs an S3-compatible server in
   `dev-oci` for the object store and, if you want attachments on S3, for the
   attachment and backup buckets. Use a throwaway one, removed afterwards.
3. `dev-env` runs PostgreSQL **18**, production runs 17 (AGENTS.md). The drill's
   own `Cluster` should use the image major version you are testing; record it.
   A restore needs the same major version as the backup.
4. Start an OCI environment from the branch (`dev-env up oci <name> --ref
   <branch>`, AGENTS.md) so the drill runs against the branch's images, and take
   it down at the end.

### Procedure

Follow [the admin guide](../admin/external-database-backup.md#cloudnativepg),
in `dev-oci`:

1. Create the bucket, the `ObjectStore` and a `Cluster` with
   `spec.plugins` (`isWALArchiver: true`), a few instances at most, small
   storage, and `archive_timeout` as the operator sets it. Check that
   `kubectl cnpg status` shows continuous archiving working.
2. Point the OCI environment's `DATABASE_URL` at the new cluster's `-rw`
   service (a throwaway OCI, not the environment's own database), migrate, set
   `databaseBackup: 'external'` and the S3 destination, and create data as the
   pgBackRest drill does: conversations and attachments, run **R1**.
3. Take a base backup (`Backup` with `method: plugin`). Write more rows and
   an attachment, record **T** from the database's clock (with a time zone),
   write more, run **R2**, and wait until WAL past T is archived
   (`pg_switch_wal()`, then the object store listing or the plugin's metrics).
4. Create the recovery `Cluster` (`bootstrap.recovery`,
   `recoveryTarget.targetTime: T`, `externalClusters` with the plugin) with
   archiving enabled to a **different** `ObjectStore`, as the guide shows. Time
   from `kubectl apply` to a ready primary.
5. Delete the attachment objects from the scratch bucket, then run the admin
   guide's checklist against a scratch OCI with `OCI_ROLE=web` only:
   `backup:restore-files` from R1 and then R2 (`--dry-run` first), **Check for
   orphans**, a provider's **Test**, a download's SHA-256, rows before and after
   T. Time the attachment restore.
6. Record the times below, delete the recovery `Cluster`, the original
   `Cluster`, the object store, the OCI environment (`dev-env down oci <name>`)
   and anything else the drill created. Check `kubectl get cluster,backup,
   objectstore -n dev-oci` shows none of it.

### Times

Not yet run for this module. Fill in when it is (an example, not a promise):

| | |
| --- | --- |
| Date, CloudNativePG and plugin versions, PostgreSQL major | |
| Plugin or in-tree form | |
| Database size, attachments (count, bytes) | |
| Base backup | |
| Restore: `kubectl apply` to a ready primary | |
| Attachments restored (R1 and R2) | |
| Checklist: all ticked? Exceptions | |

## Re-running the drill

```bash
node tools/restore-drill/run.mjs                      # builds the API image, runs, removes the stack
node tools/restore-drill/run.mjs --keep               # leaves oci-restore running to inspect
docker compose -p oci-restore -f tools/restore-drill/compose.yaml --profile restored --profile tools down -v
gh workflow run restore-drill.yml                     # on GitHub, on demand
```

It uses the Compose project `oci-restore` and ports 18781 and 18782, so it can
run beside `oci-harness`, `oci-scale` and `oci-upgrade`. It needs about 2 GB of
free Docker memory and no VPN that breaks Docker's traffic.
