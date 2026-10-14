# Restore drill

Restores an OCI database from a real pgBackRest repository to a recorded time,
then follows the procedure of
[docs/admin/external-database-backup.md](../../docs/admin/external-database-backup.md#the-restore-drill)
and fails unless OCI works afterwards. What it proves, what it cannot, and the
times it measured: [docs/dev/restore-drill.md](../../docs/dev/restore-drill.md).

```bash
node tools/restore-drill/run.mjs                     # builds the API image from this checkout
node tools/restore-drill/run.mjs --api-image oci-restore-api:drill
node tools/restore-drill/run.mjs --file-kib 2048     # bigger attachments
node tools/restore-drill/run.mjs --keep              # leave the stack running to look around
node tools/restore-drill/run.mjs --help
```

Needs Docker with about 2 GB of memory free and Node 22; no VPN that rewrites
Docker's traffic. It runs as the Compose project `oci-restore` on
`127.0.0.1:18781` (the OCI that is backed up) and `127.0.0.1:18782` (the restored
one), so it can run beside `oci-harness`, `oci-scale` and `oci-upgrade`. It
removes the project afterwards (`--keep` leaves it). The report is written to
`--out` (`report.json`, `report.md`, and `service-logs.txt` when the drill could
not run). Exit codes: 0 pass, 1 a check failed, 2 the drill could not run. The
scheduled workflow is `.github/workflows/restore-drill.yml` (weekly and on demand).

## What it does

1. PostgreSQL 17 with pgvector and pgBackRest archives WAL to a local, encrypted
   repository (`archive_timeout` 10 s). `stanza-create`, `check`, one full
   backup, taken before OCI has a single table.
2. OCI built from this checkout (`OCI_ROLE=all`) migrates, gets a provider, a
   person, conversations and attachments (on the S3 server) and
   `databaseBackup: 'external'`. Run **R1** (**Back up now**). Then more
   conversations and one more attachment, and the target time **T**, read from
   the database's clock. Then more writes (a conversation and an attachment
   after T) and run **R2**. A WAL segment switch is waited for until it is
   archived, so WAL past T is in the repository.
3. The primary and its data volume are removed and the attachment bucket is
   emptied: the repository and the backup bucket are all that is left.
4. `pgbackrest restore --type=time --target=T --target-action=promote
   --archive-mode=off` fills a fresh volume; a second PostgreSQL starts on it and
   replays WAL to T.
5. `upgrade-check` and `migrate` run against the restored database; OCI starts
   on it as `OCI_ROLE=web`, no worker. `backup:restore-files` restores the
   attachments from R1 (the newest run at or before T), then R2 (the oldest at or
   after T).

## What it checks

| Check | Fails when |
| --- | --- |
| pgBackRest | the stanza is not healthy, there is not exactly one full backup, the archiver failed, or the backup did not finish before T |
| external runs | R1 or R2 has a dump, a manifest without `database.external`, a `database.dump` object is in the bucket, copies are not what the data says, or the detail does not say the database is backed up outside OCI |
| System health row (source) | the **Database backup (external)** row is not ok on the archiving server or lacks the "Not verified by OCI" sentence |
| rows at T | conversations before T are missing, conversations after T are present, the attachment records are not A1 A2 A3 B1 only, `backup_run` is not R1 alone with NULL dump columns |
| scratch restore does not archive | the restored server has `archive_mode` on |
| upgrade preflight and migrations | `upgrade-check` or `migrate` fails on the restored database |
| OCI starts as `OCI_ROLE=web` | System health has an error other than "no background worker", or the external row is missing |
| stored credentials decrypt | a provider's stored key cannot be used (the same `ENCRYPTION_KEY`) |
| runs chosen around T | the newest run at or before T and the oldest at or after T, read from the backup bucket, are not R1 and R2 |
| `backup:restore-files` | a dry run on the emptied bucket, the restore from R1 or the restore from R2 reports a failure or an unexpected count |
| attachment RPO and Check for orphans | **Check for orphans** does not report one record without an object after R1 alone (B1 was uploaded after R1), or any after R2 too |
| attachment downloads | a restored attachment's download does not have the SHA-256 of its `attachments.jsonl` line and of what was uploaded |
| conversation with an attachment opens | the restored conversation does not reference its attachment |
| no worker, nothing written to the backup bucket | the backup bucket changed, or a run appeared, while the restored OCI ran |

It also prints the times: the full backup, `pgbackrest restore`, recovery to T
and promotion, the **time to a working database**, and the attachments (both runs;
each call includes starting a container).

Not covered: CloudNativePG (it needs Kubernetes; see the procedure in
[docs/dev/restore-drill.md](../../docs/dev/restore-drill.md)), WAL-G, restore
time at production size, and the pgBackRest repository on object storage (the
drill's repository is a local directory).

## Files

| File | Does |
| --- | --- |
| `run.mjs` | The runner: images, stack, data, the two OCI runs, the disaster, the restore, the checks, the report |
| `compose.yaml` | Compose project `oci-restore`: the primary (`pg`), the restored server (`pg-restored`, profile `restored`), the restore job, Redis, VersityGW (S3), the stub model, OCI (`api`), OCI on the restored database (`api-restored`, `OCI_ROLE=web`) and one-off jobs in the API image (`tool`) |
| `Dockerfile` | `pgvector/pgvector:pg17` plus pgBackRest from PGDG, and the repository settings; the image the guide tells Compose users to build |
| `s3tool.mjs` | A small S3 helper that runs inside the API image (create bucket, list, empty, read, checksum, list runs) so nothing has to be installed on the host |

It reuses the rolling-upgrade test's stub model, people setup and stream reader
(`tools/upgrade-test/stub-model.mjs`, `seed.mjs`, `lib.mjs`). Every credential in
it is a throwaway test value. Licences of the images: PostgreSQL, pgvector and
pgBackRest (PostgreSQL licence, PostgreSQL licence and MIT), VersityGW
Apache-2.0, Redis 7.2 BSD-3-Clause, Node.js MIT.
