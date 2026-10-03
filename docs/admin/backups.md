# Backups

**Data & storage → Backups** (`/admin/backups`). OCI can back itself up once a
day: a `pg_dump` of the database and a manifest of every attachment object,
written to S3-compatible storage, then read back and verified. Deployments that
already back up PostgreSQL and object storage their own way can leave it off.

An `auditor` sees everything on the page and changes nothing.

## What a backup contains

Each run writes one folder, named after its start time and run id:

| Object | What it is |
| --- | --- |
| `database.dump` | `pg_dump --format=custom` of the whole database: users, settings, conversations, attachment metadata, audit log, everything in PostgreSQL. |
| `attachments.jsonl` | One line per attachment object (file and thumbnail): its storage key, size and SHA-256. File names and contents are not included. |
| `manifest.json` | The OCI version, the newest applied migration, and the size and SHA-256 of the two files above. |

The dump is streamed from `pg_dump` straight into a multipart upload, a
16 MiB part at a time, so a large database never has to fit in memory or on the
API's disk. If `pg_dump` fails, the upload is aborted: a truncated archive is
never stored.

### Attachments are listed, not copied

The manifest records which attachment objects existed and their checksums; it
does not copy their bytes. This keeps a daily backup proportional to the
database, not to everything ever uploaded, but it means **a backup alone cannot
restore attachments**. Protect the attachment objects where they live:

- **S3-compatible storage**: turn on bucket versioning (and, ideally,
  replication to another bucket or region). With versioning, an object deleted
  or overwritten after a backup can be recovered, and the manifest says exactly
  which keys and checksums a restore should have.
- **Local storage**: back up the storage volume with your filesystem or volume
  snapshots, as before.

The first backup reads every attachment object once to compute its checksum.
Objects are written under a fresh key and never changed, so checksums are cached
and later backups read only new objects. An attachment whose object cannot be
read is listed with `"missing": true`; the run still succeeds, and System health
warns about it.

## Destination

| Destination | Where | When to use it |
| --- | --- | --- |
| Attachment storage bucket | The S3 bucket attachments use, under `.oci-backups/`. Storage reconciliation never treats these objects as orphans. | Quick to set up when attachments are already on S3. One credential then protects both the data and its backups. |
| Separate S3 bucket (recommended) | Its own bucket, region, endpoint, access key and prefix. The secret is stored encrypted with `ENCRYPTION_KEY` and never shown again. | Losing or leaking the attachment bucket's credentials does not also lose the backups, and the backup bucket can have its own lifecycle, versioning or object lock. Required when attachments are on the local disk. |

The separate destination refuses the attachment bucket itself; choose
*Attachment storage bucket* to use that. **Test destination** writes, reads
back and deletes a small object with the saved settings. The credential needs
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and the multipart upload
actions on the prefix.

## Schedule

With **Back up automatically** on, the backup starts within ten minutes of the
chosen hour (UTC) each day. If the API was down at that hour, it runs as soon as
it is back. A scheduled backup that fails is not retried until the next day;
fix the cause (System health shows it) and use **Back up now**. **Back up now** starts one immediately; it is recorded as manual.
Only one backup runs at a time across all replicas (it holds the
`backups.run` job lock).

Turning backups on is refused while the destination is incomplete or
`pg_dump` is missing, so a schedule that cannot work is never silently on.

### PostgreSQL client tools

The API image includes the PostgreSQL 17 client tools (`pg_dump`,
`pg_restore`). A newer `pg_dump` can dump an older server, never the reverse,
so a PostgreSQL 18 server needs newer tools. Outside the image, install the
client tools for your server version and, if they are not on `PATH`, set
`BACKUP_PG_BIN_DIR` to their directory (for example
`/usr/lib/postgresql/17/bin`). The page shows the version it found.

### The database password

`pg_dump` connects with the same `DATABASE_URL` as the API. The password is
never put on the command line (where any local user could read it from the
process list) and not in `PGPASSWORD`: it goes into a `.pgpass` file, readable
only by the API's user, in a private temporary directory removed when the dump
ends. The child process gets only the connection variables it needs, not the
API's environment, and its error output is scrubbed of the password before it
is logged or recorded. `sslmode` in the URL is honoured.

## Verification

After writing, every run reads its objects back:

- the archive's size and SHA-256 must match what was written, and
  `pg_restore --list` must read its table of contents and find tables;
- the attachment manifest's size, SHA-256 and line count must match.

A run that fails verification is recorded as failed and its objects are
deleted. The result of the latest run is shown on **System health** in the
*Backups* row: an error if it failed, a warning if no backup has completed in
over a day or objects were missing.

## Retention

After each successful backup, older ones are deleted:

- **Daily backups kept** (default 7): the newest backup of each of the last
  *n* days that have one;
- **Weekly backups kept** (default 4): the newest backup of each of the last
  *n* ISO weeks that have one.

Days and weeks are counted only when they have a backup, so a pause never
deletes the last good ones. Runs stay in the history after their objects are
deleted (marked *Expired*). Backups made before a change of destination are
left where they are; delete them by hand when no longer needed.

## Restoring

Restoring is a deliberate, manual step. Practise it into a scratch database
first; that is the only proof a backup works.

1. Download a backup folder, and check the dump against the manifest:

   ```bash
   aws s3 cp --recursive s3://oci-backups/oci-backups/2026-10-02T03-00-04-123Z-ab12cd34/ ./restore/
   jq -r .database.sha256 restore/manifest.json
   sha256sum restore/database.dump
   ```

2. Restore into a new, empty database (pgvector must be available if
   meaning-based search was on):

   ```bash
   createdb oci_restore
   pg_restore --no-owner --role=oci --dbname=oci_restore restore/database.dump
   ```

   The archive was written to a stream, so it carries no data offsets:
   restore it serially (no `--jobs`).

3. Check the attachment objects against `attachments.jsonl`: every key should
   exist in the attachment storage with the listed size and SHA-256. With S3
   versioning, recover any missing key from its previous version.

4. Point a test deployment at the restored database, with the **same
   `ENCRYPTION_KEY` and `AUTH_SECRET`** (without them, stored credentials and
   sessions cannot be read), and the same attachment storage. Run the same or a
   newer OCI version: startup applies any newer migrations.

5. Verify sign-in, a conversation, an attachment download and System health,
   then switch production over.

## Audit and metrics

Saving settings is audited as `backup.settings.update` (which fields changed,
never a credential). Every run, scheduled or manual, is audited as `backup.run`
with its outcome, so a [webhook](observability.md#webhooks) can alert on a
failed backup. The [metrics](observability.md#metrics) endpoint exposes
`oci_backup_runs_total`, `oci_backup_duration_seconds` and
`oci_backup_last_success_timestamp_seconds`.
