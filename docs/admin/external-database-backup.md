# External database backup

For clusters that already back up PostgreSQL themselves: CloudNativePG,
pgBackRest, WAL-G, volume snapshots, or a managed service's point-in-time
recovery. In this mode OCI stops dumping the database and keeps backing up
everything else it can see. It does not tell you the database backup works.
Only a restore does that, and [the restore drill](#the-restore-drill) below is
how to do it.

If you have no backups of your own, leave the default (**dump**) as it is.
[Backups](backups.md) describes it.

## What OCI does and does not do

With **Database backup** set to *Backed up outside OCI (your own tooling)* on **Data & storage → Backups**
(`databaseBackup: 'external'` in the `backups` setting), a backup run, scheduled
or manual, on the same schedule as before:

- builds the attachment manifest (`attachments.jsonl`), copies attachment files
  to `objects/<sha256>` when **Copy attachment files** is on, and reads the
  manifest and the copies back to check their size and SHA-256;
- writes `manifest.json` with `database: { external: true }` in place of the
  dump's key, size and checksum;
- applies retention and sweeps copies no kept backup lists;
- is audited as `backup.run` (its metadata says `database: 'external'` and has
  no `dumpBytes`) and counted in the `oci_backup_*` metrics.

It does not:

- run `pg_dump` or `pg_restore`, open the long control connection a dump needs,
  or need the PostgreSQL client tools (the page says *not needed*);
- start, configure, inspect or delete anything of CloudNativePG, pgBackRest or
  WAL-G, call the Kubernetes API, or hold a credential for your backup storage;
- restore the database. That is your tooling's job;
- know whether a base backup exists, is recent, or restores. The one thing it
  reads is the state of WAL archiving, shown on System health
  ([below](#what-system-health-shows)).

`backup:restore-files` works as it always did: it reads only
`attachments.jsonl` and the copies, so it restores attachments from a run made
in this mode.

**Choosing it asks for confirmation**: *OCI will stop dumping the database.
Check that your own backups work: OCI cannot.* With **Copy attachment files**
off it is allowed, but then OCI backs up nothing except a checksum list, and the
attachments need their own protection (see [Attachment files](backups.md#attachment-files)).

**Nothing changes on upgrade.** Every instance is `dump` until an administrator
changes it; OCI never infers the mode from the server's settings. Switching
deletes nothing: dumps from earlier runs expire with retention as before. A
release before v0.13 ignores the setting and starts dumping again at the next
slot, so turn **Back up automatically** off first if you roll back and do not
want that.

## Retention must cover your recovery window

OCI keeps an attachment copy only while a kept run's `attachments.jsonl` lists
it. Say your database can be restored to any time in the last 30 days, and a
person deleted a file 10 days ago. A restore to 20 days ago brings back a
conversation that references that file, but if OCI's retention has already
dropped every run that listed it, the sweep has deleted the copy. So set
**Daily backups kept** (and **Weekly backups kept**) so the oldest kept run is
at least as old as your database recovery window. Retention counts runs that
exist, not calendar days: one run a day for 30 days needs *30*.

OCI only ever deletes objects under its own backup root.

## Recovery objectives

Recovery point objective (RPO) is how much recent work a restore can lose.
Recovery time objective (RTO) is how long until you have a working system. The
table says what each depends on. **It gives no durations that this repository has
not measured**, and the repository has measured none at production size: the
drill below measures them on your system, and
[the restore drill page](../dev/restore-drill.md) records one laptop example at
small size, which is not a promise.

| Approach | Database RPO | Database RTO |
| --- | --- | --- |
| OCI `pg_dump` (the default) | Up to 24 hours (the daily slot) plus the run time | Download the archive, then a serial `pg_restore` (no `--jobs`: the archive is written to a stream, see [Restoring](backups.md#restoring)). Hours for a large database; not measured |
| CloudNativePG, WAL archive and base backups (Barman Cloud plugin) | CloudNativePG documents at most 5 minutes with WAL archiving, from its default `archive_timeout` of 5 minutes | Restore the base backup from the object store (a full copy onto new volumes), then replay WAL. Volume snapshots restore faster on very large databases |
| CloudNativePG, volume snapshots only | The snapshot interval, unless WAL is also archived | Fast; depends on the snapshot class |
| pgBackRest, WAL archive and backups | Set by `archive_timeout` (the guide below suggests 60 seconds) plus the time to push a segment. WAL not yet archived is lost with the node | `restore` with `process-max` and `--delta`, plus WAL replay |
| WAL-G | As pgBackRest | As pgBackRest |

**Attachments, in every approach.** RPO is up to one schedule interval (24
hours) for files uploaded since the last run, and a database restored to a later
time still references them. RTO is `backup:restore-files` at the link speed
between the backup bucket and attachment storage. **The objective for OCI as a
whole is the worse of the two.** Versioning on the attachment bucket is how to
shorten the attachment RPO: a file deleted or overwritten can be recovered from
its earlier version, and a file uploaded after the last run is still in the
bucket if the bucket survives.

Measure both RTOs in the drill and keep the numbers (a table is at the end).

## What System health shows

With the mode on, **System health** has a second row, **Database backup
(external)**, next to **Backups**, also while **Back up automatically** is off.
It comes from one read-only query on the application's connection to the primary
(`pg_stat_archiver`, `archive_mode`, `wal_level`, `archive_timeout`,
`pg_is_in_recovery()`), needs no privilege beyond an ordinary application role,
never reads `archive_command` (it can hold credentials), and shows WAL file
names only.

| What OCI reads | Row |
| --- | --- |
| `DATABASE_URL` names a standby | warning: point it at the primary |
| `archive_mode` off or `wal_level` minimal | warning: point-in-time recovery is not possible from this server. Setting `walArchivingExpected` to false (snapshot-style backups) turns this into ok, "as configured" |
| The archiver is failing now: the last failure is newer than the last success, and the last success is over 15 minutes ago or none | **error**: WAL piles up on the primary's disk and recovery points stop advancing |
| A failure, but a success within 15 minutes | warning: retrying |
| `archive_timeout` above 0 and no success for three times that (at least 15 minutes) | warning: the server may only be idle |
| `archive_timeout` is 0 | no judgement about staleness; an idle server can go long between segments |
| Archiving works | ok: the last segment and when |
| Any read not permitted | warning that says what could not be read |

**Every state ends with: "Not verified by OCI: that a base backup exists, is
recent, or restores. Run the restore drill."** The row is red only for an
archiver that is failing now, because that is the one condition OCI can see that
harms the primary (a full WAL disk) and ends recoverability. It is never green
on "the backup is good". OCI cannot see replica lag (it needs `pg_monitor`),
base backup age or snapshot state.

The **Backups** row keeps its rules; its summary says "database backed up
outside OCI" instead of a database size.

### Metrics and alerts

In this mode, and only this mode, `/metrics` also exposes
`oci_wal_archive_last_success_timestamp_seconds` (absent when there has been no
success) and `oci_wal_archive_failing` (1 when the newest attempt failed after
the newest success, else 0; it can be 1 during a retry that System health still
shows as a warning).
`oci_backup_last_success_timestamp_seconds` keeps meaning "the attachment
backup". [Observability](observability.md#metrics) has the alert examples.

OCI cannot see that base backups stopped: WAL can keep archiving while the
oldest base backup expires, for instance when a `ScheduledBackup` is suspended or
a pgBackRest cron job fails. Alert on that in the tools' own metrics, from your
Prometheus:

- CloudNativePG with the plugin:
  `barman_cloud_cloudnative_pg_io_last_available_backup_timestamp`,
  `barman_cloud_cloudnative_pg_io_last_failed_backup_timestamp` and
  `barman_cloud_cloudnative_pg_io_first_recoverability_point`
  ([plugin observability](https://cloudnative-pg.github.io/plugin-barman-cloud/docs/observability/));
- pgBackRest: `pgbackrest info --output=json` gives each backup's stop time and
  the archive range; export it with your usual job or exporter.

## CloudNativePG

This part follows the CloudNativePG documentation (checked against its current
`main` branch and the Barman Cloud plugin's usage and migration pages in
October 2026; the manifests here were **not** run by this repository's CI, see
[the drill](#the-restore-drill)). Check them against the operator version you
run.

Since CloudNativePG 1.26 the in-tree `barmanObjectStore` is deprecated in
favour of the **Barman Cloud plugin**, so new clusters should use the plugin.
Its requirements: CloudNativePG 1.26 or newer, cert-manager, and the plugin
installed in the operator's namespace.

Create the bucket first; recent Barman Cloud versions do not create it.

### Object store, WAL archiving and backups with the plugin

```yaml
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: oci-db-backups
spec:
  retentionPolicy: 30d          # a recovery window; see "Retention" above
  configuration:
    destinationPath: s3://<bucket>/
    endpointURL: https://<s3 endpoint>     # omit for AWS
    s3Credentials:
      accessKeyId:     { name: oci-db-backup-s3, key: ACCESS_KEY_ID }
      secretAccessKey: { name: oci-db-backup-s3, key: ACCESS_SECRET_KEY }
    wal:
      compression: gzip
---
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: oci-db
spec:
  instances: 3
  storage:
    size: <size>
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: oci-db-backups
---
apiVersion: postgresql.cnpg.io/v1
kind: ScheduledBackup
metadata:
  name: oci-db-daily
spec:
  cluster:
    name: oci-db
  schedule: '0 0 2 * * *'       # six fields, the first is seconds: daily 02:00:00
  backupOwnerReference: self
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
```

- `isWALArchiver: true` archives WAL; the same entry takes base backups.
  `archive_timeout` defaults to 5 minutes in CloudNativePG, which is what its
  5-minute RPO rests on.
- `ScheduledBackup` uses a **six-field cron expression with seconds first**, not
  the five-field form of a Kubernetes `CronJob`.
- An on-demand backup is a `Backup` with `method: plugin` and
  `pluginConfiguration.name: barman-cloud.cloudnative-pg.io`, or
  `kubectl cnpg backup <cluster> --method=plugin --plugin-name=barman-cloud.cloudnative-pg.io`.
- Retention lives in the `ObjectStore` (`spec.retentionPolicy`), as a recovery
  window. Make it at least as long as the **Daily backups kept** window you chose
  in OCI.
- **On-demand backups do not include the Kubernetes Secrets** for the PostgreSQL
  superuser and application user. Back those up with your cluster backup.
- Point `DATABASE_URL` at the `<cluster>-rw` service (the primary), never `-ro`:
  a standby makes System health warn, and OCI writes.

### Point-in-time recovery

CloudNativePG does not recover in place: it bootstraps a **new** `Cluster` from
the object store.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: oci-db-restore
spec:
  instances: 1
  storage:
    size: <size>
  bootstrap:
    recovery:
      source: origin
      recoveryTarget:
        targetTime: '2026-10-13T11:14:21Z'   # always with a time zone
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: oci-db-backups
          serverName: oci-db
```

CloudNativePG picks the closest base backup completed before the target. PostgreSQL
stops at the first transaction after the target time, so the archive must hold
WAL past it. **This configuration does not enable WAL archiving on the restored
cluster.** To archive from it, add a `plugins` entry with `isWALArchiver: true`
that points at a **different** `ObjectStore` (or at least a different
`serverName`): CloudNativePG refuses to archive into a location that already
holds another cluster's WAL (`Expected empty archive`).

To go back into service you then point OCI (`DATABASE_URL`) at the new cluster's
`-rw` service. Follow [the drill](#the-restore-drill) first and with a scratch
cluster, not production.

### Clusters still on the in-tree form

A cluster that has not migrated keeps `spec.backup.barmanObjectStore`, a
`ScheduledBackup` without `method: plugin`, and `bootstrap.recovery` with an
`externalClusters[].barmanObjectStore` entry. It works in 1.26 and later but is
deprecated; the plugin's
[migration guide](https://cloudnative-pg.github.io/plugin-barman-cloud/docs/migration/)
translates it with no data loss (note that the retention policy moves from the
`Cluster` to the `ObjectStore`, and the metrics change names).

### Volume snapshots

`method: volumeSnapshot` takes a Kubernetes `VolumeSnapshot` of the data
directory, and recovery can start from it (`bootstrap.recovery.volumeSnapshots`).
It needs a CSI driver and a snapshot class that support it. Without a WAL archive
the RPO is the snapshot interval; with one, snapshots are the base backup and
WAL does the rest. They restore faster than an object store copy on very large
databases. The Kubernetes Secrets caveat applies.

## pgBackRest

pgBackRest runs next to PostgreSQL, not in OCI's image. Option names below are
from pgBackRest 2.59 documentation.

`/etc/pgbackrest/pgbackrest.conf`:

```ini
[global]
repo1-type=s3
repo1-s3-bucket=<bucket>
repo1-s3-endpoint=<s3 endpoint>
repo1-s3-region=<region>
repo1-path=/pgbackrest
repo1-s3-key=<access key id>
repo1-s3-key-secret=<secret access key>
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<long random passphrase>
repo1-retention-full=2
process-max=4
start-fast=y
# Optional: push WAL in batches.
# archive-async=y
# spool-path=/var/spool/pgbackrest

[oci]
pg1-path=/var/lib/postgresql/data
```

A repository on the same disk as the database is not a backup. Put it in object
storage or on another host.

In `postgresql.conf`:

```ini
archive_mode = on
archive_command = 'pgbackrest --stanza=oci archive-push %p'
archive_timeout = 60
```

`archive_mode` needs a restart. `archive_timeout` is what bounds the RPO on a
quiet server (PostgreSQL switches to a new segment after that many seconds if
there was any activity); a minute or so is what the PostgreSQL manual calls
reasonable, since every forced switch is a full-size segment before compression.
With `archive-async`, `archive_command` still reports success only after the
segment is stored in the repository, so WAL not yet archived is lost with the
node either way.

Until `stanza-create` has run, every archive attempt fails (and System health
shows a retry warning or, after 15 minutes, the archiver error), so run the
commands below right after the restart. As the `postgres` user:

```bash
pgbackrest --stanza=oci stanza-create
pgbackrest --stanza=oci check             # archiving and the repository work
pgbackrest --stanza=oci --type=full backup
pgbackrest --stanza=oci info
```

- Schedule backups with cron or your orchestrator (for example a weekly full and
  a daily differential). `repo1-retention-full` keeps that many full backups and
  `expire` (run after each backup) removes older backups and the WAL they needed.
  Keep enough that the oldest recovery point is at least as old as the **Daily
  backups kept** window in OCI.
- `pgbackrest --stanza=oci verify` checks the repository's files and WAL
  continuity. It does not restore anything; the drill does.
- **The cipher passphrase is as critical as `ENCRYPTION_KEY`.** Without it the
  repository is unreadable. Store it somewhere that survives the loss of the
  server and the repository.

### Point-in-time recovery

Stop PostgreSQL, then restore into the data directory (`--delta` restores only
what differs and removes what the backup does not contain; without it the
directory must be empty):

```bash
pgbackrest --stanza=oci --delta --process-max=4 \
  --type=time "--target=2026-10-13 11:14:21+00" \
  --target-action=promote restore
```

Start PostgreSQL; it replays WAL up to the target and promotes. Always give the
target a time zone. The restore needs the same PostgreSQL major version, and the
pgvector extension must be installed in the image.

If the restored server is a scratch copy, add `--archive-mode=off` so it does not
push WAL into the production repository. For a restore that is to become the new
primary, leave archiving on and take a new full backup soon after.

### Docker Compose

OCI does not ship PostgreSQL with pgBackRest. If you run Compose, build your own
image:

```dockerfile
FROM pgvector/pgvector:pg17
RUN apt-get update \
 && apt-get install -y --no-install-recommends pgbackrest \
 && rm -rf /var/lib/apt/lists/*
```

Use a volume for the repository path that the `postgres` user can write, or an S3
repository. The [restore drill tool](../dev/restore-drill.md) builds this image
(`tools/restore-drill/Dockerfile`) and is a working example of the settings above.

## WAL-G

Documented only: this repository does not test it. WAL-G has the same shape as
pgBackRest, and the same RPO logic. `archive_command = 'wal-g wal-push %p'` and
`restore_command = 'wal-g wal-fetch %f %p'` carry WAL, `wal-g backup-push
$PGDATA` takes a base backup, `wal-g backup-fetch <dir> LATEST` restores one,
and `wal-g delete retain FULL <n> --confirm` applies retention. Configuration is
by environment (for S3, `WALG_S3_PREFIX` and the AWS variables) plus an
encryption key if you use one, which you must back up like the pgBackRest
passphrase. Set `archive_timeout` as for pgBackRest, and run the drill.

## What else must be backed up

A database restore alone does not give you a working OCI. Keep, outside the
cluster and surviving its loss:

- **`ENCRYPTION_KEY`** and, if you rotated it within the database recovery
  window, **the previous keys**. A point-in-time recovery to a time before a
  rotation holds values encrypted with the older key: see
  [Rotating ENCRYPTION_KEY](../OPERATIONS.md#rotating-encryption_key) ("older
  database backups still need it"), and set `ENCRYPTION_KEYS_PREVIOUS`.
- **`AUTH_SECRET`**. Without it, sessions and signed tokens cannot be read.
- **The Kubernetes Secrets** and the `DATABASE_URL` credentials, including the
  ones CloudNativePG creates for the cluster (on-demand backups do not include
  them).
- **The object storage credentials** for attachments, and the attachment
  bucket itself (versioning, replication, or OCI's copies).
- **The backup bucket** that holds OCI's attachment copies and manifests.
- **The external backup's own credentials**: the CloudNativePG `ObjectStore`
  secret, the pgBackRest cipher passphrase and repository credentials, WAL-G's
  keys.

## Compliance note

Data erased in OCI (a deleted conversation, a purged account, a retention run)
stays in the database backups you take outside OCI until those backups expire,
and OCI neither sees nor deletes them. Set their retention to match what you
promise people. See [Compliance](compliance.md).

## The restore drill

A backup is proven by restoring it. Do this when you set the backups up, every
quarter, and after any change to the backup configuration or the PostgreSQL major
version.

1. **Pick a scratch place**: a scratch namespace (on the maintainers' cluster
   that is `dev-oci`, never production) or a Compose project. Never use
   production credentials.
2. **Restore the database to a time T** with your tooling. T is a moment you
   know: a row you can name as written before it and another written after.
3. **Restore the attachments** with `backup:restore-files` (`--dry-run` first)
   from the newest OCI run at or before T **and** from the oldest at or after T.
   Objects already present are left alone, so both can be applied. Files
   uploaded after the chosen run have no copy: that is the attachment RPO.
4. **Give the scratch OCI the same `ENCRYPTION_KEY`** (and previous keys) and
   `AUTH_SECRET`.
5. **Start it with `OCI_ROLE=web` and no worker.** The restored database carries
   the production `backups` setting. With **Back up automatically** on, a worker
   would back up into the production bucket and run the sweep, which deletes
   copies the restored database's runs do not list. It would also send webhooks
   and compliance exports. Without a worker none of that runs. (The restore
   steps in [Backups](backups.md#restoring) say the same.)
6. **Check**, and tick each:

   - [ ] Migrations apply: the preflight (`node dist/scripts/upgrade-check.js`
     in the API image, `pnpm upgrade:check` from a checkout) reports nothing
     blocking, then startup applies them.
   - [ ] An administrator signs in (`AUTH_SECRET`).
   - [ ] A provider's **Test** passes (`ENCRYPTION_KEY`).
   - [ ] System health shows no error except *no background worker*.
   - [ ] **Check for orphans** ([Operations](operations.md#storage-reconciliation))
     reports records with no object = 0, or each one is explained as uploaded
     after the chosen run.
   - [ ] A conversation with an attachment opens, and the download's SHA-256
     equals its line in `attachments.jsonl`.
   - [ ] Rows written before T are present and rows written after T are absent.

7. **Record** the times and the choices, compare them with your objectives, and
   **tear the scratch environment down**.

| | |
| --- | --- |
| Date, who | |
| Approach (CloudNativePG plugin, pgBackRest, ...) and versions | |
| T | |
| OCI runs used (at or before T, at or after T) | |
| Time to a working database | |
| Time to restore attachments | |
| Files uploaded after the chosen run (attachment RPO, as found) | |
| Checklist: all ticked? Exceptions | |

This repository runs the pgBackRest version of this procedure weekly in Docker
and the CloudNativePG version by hand before releases that touch backups; see
[Restore drill](../dev/restore-drill.md) for what that proves and what it
cannot.
