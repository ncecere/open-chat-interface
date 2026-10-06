# Backups

**Data & storage → Backups** (`/admin/backups`). OCI can back itself up once a
day: a `pg_dump` of the database, a manifest of every attachment object and,
with **Copy attachment files** on, copies of those files, written to
S3-compatible storage, then read back and verified. Deployments that already
back up PostgreSQL and object storage their own way can leave it off.

An `auditor` sees everything on the page and changes nothing.

## What a backup contains

Each run writes one folder, named after its start time and run id. Copied
files sit beside the folders, shared by all of them:

| Object | What it is |
| --- | --- |
| `<folder>/database.dump` | `pg_dump --format=custom` of the whole database: users, settings, conversations, artifacts, attachment metadata, audit log, everything in PostgreSQL. |
| `<folder>/attachments.jsonl` | One line per attachment object (file and thumbnail) and the uploaded instance logo: its storage key, size and SHA-256. File names and contents are not included. |
| `<folder>/manifest.json` | The OCI version, the newest applied migration, the size and SHA-256 of the two files above, and whether (and how many) files were copied. |
| `objects/<sha256>` | With copying on: the bytes of each attachment object, stored once per distinct content. |

Artifacts are stored in PostgreSQL, so they are in the dump.

The dump is streamed from `pg_dump` straight into a multipart upload, a
16 MiB part at a time, so a large database never has to fit in memory or on the
API's disk. If `pg_dump` fails, the upload is aborted: a truncated archive is
never stored.

The first backup reads every attachment object once to compute its checksum.
Objects are written under a fresh key and never changed, so checksums are cached
and later backups read only new objects. An attachment whose object cannot be
read is listed with `"missing": true`; the run still succeeds, and System health
warns about it.

## Attachment files

With **Copy attachment files** on, each backup copies attachment objects to the
destination under `objects/`, named by their SHA-256 (for example
`oci-backups/objects/9f86d0…`):

- **Incremental.** An object is copied only when its SHA-256 is not there yet.
  The first backup copies everything; later ones copy only files uploaded
  since, and a file uploaded twice is stored once.
- **Streamed and checked.** Files stream from attachment storage (local disk or
  S3) to the destination, at most four at a time and one 16 MiB part each in
  memory. Bytes that do not match the recorded checksum never complete a copy;
  that attachment is listed as missing with `"error": "checksum mismatch"` and
  checksummed afresh by the next backup.
- **Kept as long as a backup needs them.** After retention, copies that no kept
  backup's `attachments.jsonl` lists are deleted (see [Retention](#retention)).

**Cost.** The first copy uses as much storage again as attachments use now, at
the destination (with *Attachment storage bucket*, in the attachment bucket
itself), and its transfer may be billed by your provider. After that, storage
grows with new uploads, not with the number of backups kept.

**On or off by default.** A new backup configuration has copying on. An
instance that saved backup settings before v0.10 keeps the old behaviour, a
manifest without copies, until an administrator turns copying on, so an
upgrade never starts a large copy on its own. While copying is off, the page
says so, and **a backup alone cannot restore attachments**: protect the
objects where they live instead:

- **S3-compatible storage**: turn on bucket versioning (and, ideally,
  replication to another bucket or region). With versioning, an object deleted
  or overwritten after a backup can be recovered, and the manifest says exactly
  which keys and checksums a restore should have.
- **Local storage**: back up the storage volume with your filesystem or volume
  snapshots.

## Destination

| Destination | Where | When to use it |
| --- | --- | --- |
| Attachment storage bucket | The S3 bucket attachments use, under `.oci-backups/`. Storage reconciliation never treats these objects as orphans. | Quick to set up when attachments are already on S3. One credential then protects both the data and its backups, and copied files double the bucket's size. |
| Separate S3 bucket (recommended) | Its own bucket, region, endpoint, access key and prefix. The secret is stored encrypted with `ENCRYPTION_KEY` and never shown again. | Losing or leaking the attachment bucket's credentials does not also lose the backups, and the backup bucket can have its own lifecycle, versioning or object lock. Required when attachments are on the local disk. |

The separate destination refuses the attachment bucket itself; choose
*Attachment storage bucket* to use that. **Test destination** writes, reads
back and deletes a small object with the saved settings. The credential needs
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` (to find
unreferenced copies) and the multipart upload actions on the prefix.

A bucket and prefix belong to one OCI instance. Do not point two instances'
backups at the same prefix: each would delete the other's copies as
unreferenced.

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
- the attachment manifest's size, SHA-256 and line count must match;
- with copying on, copied files are read back from the destination and their
  size and SHA-256 checked against the manifest: a random sample of 32 distinct
  files each run, or every file with **Files checked after each backup** set to
  *Every file* (which reads the whole copy every day). Each run checks files
  copied earlier too, so a damaged or deleted copy is found.

A run that fails verification is recorded as failed and its folder is deleted
(copies stay; they are shared with other backups). The result of the latest
run is shown on **System health** in the *Backups* row: an error if it failed,
a warning if no backup has completed in over a day or objects were missing.
The history shows, per run, how many files were copied and already backed up
(with their sizes), how many were read back, and how many unused copies were
deleted.

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

Then copied files are swept: every kept backup that copied files has its
`attachments.jsonl` read, and copies under `objects/` that none of them lists
are deleted. So a deleted attachment's file stays as long as a kept backup
includes it. The sweep runs under the backup job lock, deletes only copies at
least a day old (a backup still writing is never undercut), leaves names that
are not a SHA-256 alone, and deletes nothing if any kept manifest cannot be
read. Turning copying off lets the copies age out with the backups that made
them.

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

3. Restore the attachment files. If the backup copied them
   (`jq .files.copied restore/manifest.json` is `true`), use the restore
   script. It reads `attachments.jsonl`, streams each `objects/<sha256>` back to
   its original storage key, checks every file's SHA-256 on the way, and
   leaves objects already present alone (`--overwrite` replaces them). It needs
   no database. Credentials come from the environment only:

   ```bash
   export BACKUP_S3_BUCKET=oci-backups BACKUP_S3_REGION=us-east-1 \
     BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=...
   # BACKUP_S3_ENDPOINT and BACKUP_S3_FORCE_PATH_STYLE=true for MinIO and similar.
   FOLDER=oci-backups/2026-10-02T03-00-04-123Z-ab12cd34/

   # Local attachment storage (the directory STORAGE_LOCAL_PATH names):
   docker compose exec api node dist/scripts/restore-backup-files.js "$FOLDER" --to-local /data/storage
   # S3 attachment storage, named by TARGET_S3_BUCKET, TARGET_S3_REGION,
   # TARGET_S3_ENDPOINT, TARGET_S3_ACCESS_KEY_ID, TARGET_S3_SECRET_ACCESS_KEY:
   node dist/scripts/restore-backup-files.js "$FOLDER" --to-s3
   # From a checkout: pnpm --filter @oci/api backup:restore-files "$FOLDER" --to-s3
   ```

   Add `--dry-run` first to see what would be restored. It prints how many
   files were restored, already present, listed as missing when the backup was
   made, and failed (with each failed key), and exits 1 if any failed.

   Without the script, the layout is simple enough for any tool: for each line
   of `attachments.jsonl` without `"missing"`, copy `objects/<sha256>` (beside
   the backup folders) to `<key>` in attachment storage, then check its
   SHA-256. For example:

   ```bash
   jq -r 'select(.missing != true) | "\(.sha256) \(.key)"' restore/attachments.jsonl |
     while read -r sha key; do
       aws s3 cp "s3://oci-backups/oci-backups/objects/$sha" "s3://oci-attachments/$key"
     done
   ```

   If the backup did not copy files, check the attachment objects against
   `attachments.jsonl` instead: every key should exist in attachment storage
   with the listed size and SHA-256. With S3 versioning, recover any missing
   key from its previous version.

4. Point a test deployment at the restored database, with the **same
   `ENCRYPTION_KEY` and `AUTH_SECRET`** (without them, stored credentials and
   sessions cannot be read), and the restored attachment storage. Run the same
   or a newer OCI version: startup applies any newer migrations.

5. Verify sign-in, a conversation, an attachment download and System health,
   then switch production over.

## Audit and metrics

Saving settings is audited as `backup.settings.update` (which fields changed,
never a credential), and **Test destination** as `backup.test` with the destination, whether it
passed and, when it did not, why (never a credential). Every run, scheduled or manual, is audited as `backup.run`
with its outcome (and, with copying on, the files and bytes copied), so a
[webhook](observability.md#webhooks) can alert on a failed backup. The
[metrics](observability.md#metrics) endpoint exposes `oci_backup_runs_total`,
`oci_backup_duration_seconds` and `oci_backup_last_success_timestamp_seconds`.
