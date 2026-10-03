# Production operations

This guide supplements the deployment overview in [README.md](../README.md).
Test backup and recovery procedures against your own storage and identity
provider configuration before relying on them in production.

## Deploy a released version

Authenticate to GHCR and select a release tag. The repository is private;
verify both GHCR packages are also private, since package visibility is
independent and is not enforced by the workflow. Supply a personal access token (classic) with
`read:packages` and repository/package access through your secret manager; never
commit registry credentials or put them in `.env.example`.

```bash
export OCI_VERSION=v0.9.2
export OCI_REGISTRY=ghcr.io/ncecere/open-chat-interface
# GHCR_READ_TOKEN is supplied externally by your secret manager.
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u ncecere --password-stdin
export OCI_API_IMAGE="$OCI_REGISTRY/api:$OCI_VERSION"
export OCI_WEB_IMAGE="$OCI_REGISTRY/web:$OCI_VERSION"
```

Published images are `linux/amd64` only, matching the previous release
architecture. Confirm **Publish containers** succeeded for your version before
pulling. Historical `v0.4.1` publication uses the manual dispatch described
in [Release process](RELEASING.md). CI publishing uses `GITHUB_TOKEN`; the token
above is a deployment credential, not a saved CI PAT.

Create `docker/.env` from `.env.example` or provide the required variables
through your secret manager. For a **fresh installation**, pull and start without
local builds as below. Existing instances must first follow the drained upgrade
procedure later in this guide; do not use this shortcut for a 0.5.0 upgrade:

```bash
cd docker
docker compose pull api web migrate
docker compose up -d --no-build
docker compose ps
curl --fail "http://localhost:${OCI_PORT:-8080}/api/health/ready"
```

Pin production to `vX.Y.Z`; use `latest` only for evaluation environments.
`latest` advances only after both images succeed and the tag is the newest
stable release on `main`. Existing matching release images are reused on a
retry, not overwritten; conflicting image metadata fails publication. This
assumes the serialized workflow is the only registry writer: GHCR tags remain
mutable. Pin by digest for content identity independent of tag writers.

Promotion of the two `latest` aliases is sequential, not atomic. If one update
fails, retry publication for the unchanged release; do not deploy a mixed pair.
Version/digest-pinned deployments avoid this `latest` transition window.

Compose still defaults to local source builds when `OCI_API_IMAGE` and
`OCI_WEB_IMAGE` are unset. For released deployments, keep both overrides set
and use `--no-build` on startup and rollout commands.

Historical GitLab releases and images remain on GitLab. GitHub Actions does not
copy them or their release metadata; choose GHCR only for versions successfully
published there.

## Behind another proxy or an ingress

OCI records a client address on sessions (**People** → a person's active
sessions), in the audit log, and the authentication rate limit counts requests
per address. The web
container's Caddy decides that address and passes exactly one to the API, as
`X-Forwarded-For`; the API believes nothing else. Caddy also drops
`X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` and `Forwarded`, so a client
cannot choose its own address by sending them.

By default Caddy trusts nothing in front of it, so the address is whatever
connected to the web container. Exposed directly, that is the client. Behind a
load balancer, another reverse proxy or a Kubernetes ingress, it is that
proxy, and every person appears to come from the same address — which also
means they share one authentication rate limit.

Set `TRUSTED_PROXIES` on the **web** container to the addresses of the proxies
in front of it, separated by spaces. Each entry is an IP address or a CIDR
range; `private_ranges` stands for all private and loopback ranges:

```bash
# docker/.env
TRUSTED_PROXIES=10.0.0.0/8 192.168.10.5
```

Caddy then reads `X-Forwarded-For` from those proxies right to left, skipping
trusted hops, and the first address that is not trusted is the client. A value
the client put at the left of the header is never reached. Requests from any
other address ignore the header, as before.

Trust only addresses that really are your proxies, and make sure each one sets
or appends `X-Forwarded-For` (most do by default; NGINX needs
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`). In Kubernetes,
use the ingress controller pods' range, or the cluster's pod CIDR. A proxy that
replaces the client address entirely (TCP load balancers without the PROXY
protocol) cannot be recovered from; use the load balancer's HTTP mode.

The bundled Compose file passes `TRUSTED_PROXIES` through to the web container.
Outside Compose, set it as an environment variable of the web image. Commas are
not separators; use spaces. The API itself has no such setting: it trusts the
web container's header and, if more than one address arrives, only the last.
Do not route `/api` to the API service around the web container, or the API has
no trustworthy address to record.

## Database connections for maintenance

Background jobs use session-level advisory locks. `DATABASE_URL` must point to
PostgreSQL directly or through a **session-mode** pooler; transaction-mode
pooling does not preserve lock ownership. Each concurrently attempted job opens
one private lock connection per API replica in addition to the normal application
pool (default ten connections). Include that headroom in database connection
limits. See [background jobs](admin/operations.md#background-jobs) for scheduling
and retry guarantees; jobs are listed, and can be run by hand, on **Admin → Data
& storage → System health**.

## Back up

Back up all durable state before an upgrade:

- PostgreSQL contains users, authentication state, settings, provider/model
  configuration, conversations, quotas, and attachment metadata.
- The configured local or S3-compatible storage contains attachment objects.
- Your secret manager contains `AUTH_SECRET`, `ENCRYPTION_KEY`, database
  credentials, and deployment configuration. Losing `ENCRYPTION_KEY` makes
  encrypted provider and integration credentials unrecoverable.

Example PostgreSQL backup for the bundled Compose stack:

```bash
cd docker
docker compose exec -T postgres \
  pg_dump --format=custom --no-owner --username=oci oci > "oci-$(date +%F).dump"
```

For local attachment storage, stop API writes and archive the `oci_storage_data`
volume. For S3-compatible storage, use versioning or the provider's supported
replication/export mechanism; copying only database metadata is insufficient.

Periodically restore both database and object data into an isolated environment
and verify attachment downloads.

From v0.9, OCI can run the database backup itself, daily, to S3-compatible
storage, with a checksummed manifest of attachment objects and verification
after every run: **Admin → Data & storage → Backups**
([Backups](admin/backups.md)). From v0.10 it can also copy the attachment
files there (**Copy attachment files**), incrementally and by content, and
`backup:restore-files` puts them back; with copying on, a backup restores
everything but the deployment secrets. With copying off (the default for
instances that configured backups before v0.10), the manifest only lists the
objects, so attachment storage still needs versioning or snapshots as above.

## Upgrade

1. Read every changelog entry between the deployed and target versions.
2. Back up PostgreSQL, attachment objects, and deployment secrets.
3. Pull the target versioned API and web images.
4. For a multi-replica deployment, run migrations once before replacing API
   replicas:

   ```bash
   docker compose --profile tools run --rm migrate
   RUN_MIGRATIONS=false docker compose up -d --no-build
   ```

   A single-replica deployment may leave `RUN_MIGRATIONS=true`; startup applies
   migrations under a transaction-scoped PostgreSQL advisory lock, with lock,
   journal reads and DDL pinned to one physical transaction. A disconnect fails
   the attempt instead of continuing on an unlocked replacement connection.
   Direct PostgreSQL or session-mode pooling remains required for maintenance jobs.
   With `RUN_MIGRATIONS=false`, startup refuses to serve unless the latest bundled
   migration's timestamp is recorded. That marker is not a schema-integrity check
   or evidence that reverting an image after newer migrations is safe.
5. Wait for `/api/health/ready`, then verify authentication, chat, search, and
   attachment access.

### Upgrading to v0.7 (migrations 0022–0025)

Migrations `0022_conversation_imports` and `0024_projects` create new tables
and add nullable columns to `thread` and `attachment`, with no table rewrite.
Their new constraints and partial indexes read `thread` and `attachment` once,
which is quick. Migrations 0023 and 0025 do more work and are described below.

### Conversation search index (migration 0023)

Migration `0023_message_text_search` builds a GIN full-text index,
`message_text_search_idx`, over the text of every stored message. Migrations
run inside one transaction, so the index cannot be built `CONCURRENTLY`:

- On a large `message` table the build takes time, roughly proportional to
  the amount of stored message text, and the migration does not finish until
  it does. Allow for it in the maintenance window and in any readiness or
  start-up timeout when `RUN_MIGRATIONS=true`.
- While it builds, writes to `message` are blocked. Chat turns wait (and may
  time out) until the migration commits; reads are unaffected. For a
  multi-replica deployment, run the `migrate` job before replacing API
  replicas, as above, during a quiet period.
- The index needs disk space while building and afterwards. Check free space
  on the PostgreSQL volume first; the index is typically a sizeable fraction
  of the message text it covers.

To build it ahead of the upgrade without blocking writes, an operator can run
the same statement with `CONCURRENTLY` from a direct (non-pooled) connection
before deploying. The migration's `IF NOT EXISTS` then finds it and does
nothing. The expression must match exactly, or search cannot use it:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "message_text_search_idx" ON "message"
  USING gin (to_tsvector('simple'::regconfig, jsonb_path_query_array("parts", '$[*] ? (@.type == "text").text'::jsonpath)));
```

If a concurrent build fails it leaves an `INVALID` index behind; drop it
(`DROP INDEX CONCURRENTLY message_text_search_idx;`) and retry, because the
migration will otherwise skip it.

### Retried replies (migration 0025)

Migration `0025_reply_alternates` adds a nullable `message.superseded_at`
(no table rewrite) and backfills it: for every turn that was retried, all but
the newest reply are marked as replaced, so the model, exports, share links
and search stop seeing both answers. The backfill reads `message` once with a
sort and updates only those older replies; it holds row locks on them until
the migration commits. Re-running it changes nothing.

### Project file search (v0.8, migration 0026)

Migration `0026_project_file_chunks` creates two new, empty tables,
`project_file_index` and `project_file_chunk` (with a GIN full-text index),
both cascading from `attachment`. It rewrites and locks nothing existing, so
it applies instantly.

Project files uploaded before the upgrade are split into searchable chunks
afterwards by the `projects.index-files` background job: every 5 minutes, up
to 50 files per run, oldest first, each in its own transaction. It is safe to
interrupt (a restart loses at most the file in progress, which the next run
redoes) and safe to run on several replicas (a file is never indexed twice).
Until a file is indexed it is used whole, as in v0.7, and the project page
shows it as "Waiting to be indexed". Progress is visible in the job runs on the
admin health page; a run reports how many files it indexed. Chunks take
roughly as much space as the extracted text of the files they cover, plus the
index.

### MCP connectors (v0.8, migration 0027)

Migration `0027_connectors` creates three new, empty tables, `connector`,
`connector_tool` and `connector_account`, cascading from the organization,
the connector and the user. It rewrites and locks nothing existing, so it
applies instantly. Nothing is offered to models until an administrator adds a
connector, enables its tools and allows them for a role
([Connectors](admin/connectors.md)).

Connector credentials and people's OAuth tokens are encrypted with
`ENCRYPTION_KEY`, like provider keys: rotating that key makes them unreadable,
so re-enter shared credentials and ask people to connect again afterwards.
OAuth connectors send people back to `APP_URL/api/connectors/oauth/callback`;
`APP_URL` must be the address people use. Connectors make outbound HTTPS
requests from the API, so allow egress to their servers (and their
authorization servers) where egress is filtered.

### Upgrading to v0.9

#### Conversation compaction (migration 0028)

Migration `0028_conversation_compaction` creates two new, empty tables:
`conversation_compaction` (the summaries), cascading from the thread, the user
and the message where a summary's kept messages begin, and
`conversation_compaction_job` (at most one queued or running summary request
per conversation), cascading from the thread and the user. It rewrites and
locks nothing existing, so it applies instantly, and v0.8 replicas never read
it. From v0.9, long conversations are summarised in the background instead of
losing their oldest turns; each summary call is a usage event of its own (no
message counted) for the conversation's model. Summaries are made by the
`chat.compact-conversations` background job (every minute, plus an immediate
in-process start after each request), with the background jobs that already
run on every replica. Replicas claim requests with a lease, so several never
summarise one conversation twice, and a request interrupted by a restart is
taken over after 15 minutes. Administrators can turn automatic
summaries off under **General → Summarise long conversations**
([Instance settings](admin/instance-settings.md#general)).

#### Meaning-based search and pgvector (migration 0029)

Migration `0029_embeddings` adds one small table
(`project_file_embedding_failure`) and needs no extension; v0.8 replicas never
read it. Meaning-based search for project files is optional and off until an
administrator configures an embeddings model under **Providers & Models →
Embeddings** ([Embeddings](admin/models-providers.md#embeddings)). It also
needs the [pgvector](https://github.com/pgvector/pgvector) extension, which OCI
detects but never creates: without it, project search stays keyword-only,
exactly as in v0.8. **System health** shows the state in its *Meaning-based
search* row.

Once both are in place, OCI creates a `project_file_embedding` table at runtime
(its `vector(n)` column depends on the model) under an advisory lock, and the
`projects.embed-passages` job fills it in the background. The table is part of
the database, so `pg_dump` backs it up; a restore needs pgvector on the target
server.

**Enabling pgvector.** If your PostgreSQL server has the pgvector package
(managed services usually offer it; the `pgvector/pgvector:pg17` image includes
it), enable it once in OCI's database as a superuser or, on a managed service,
the role it allows to create extensions:

```bash
cd docker
docker compose exec -T postgres psql --username=oci --dbname=oci \
  -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

**The bundled Compose stack uses `postgres:17-alpine`, which does not include
pgvector.** There are two ways to get it.

*Option 1: move to the Debian-based `pgvector/pgvector:pg17` image with a dump
and restore.* Do not point the new image at the existing data volume. Alpine
uses musl and Debian uses glibc, which sort text differently; a data directory
created under one and opened under the other can silently corrupt text indexes
(unique constraints may stop being enforced and lookups may miss rows).

1. Stop the API (`docker compose stop api`) so nothing writes during the move.
2. Dump the database, as in [Back up](#back-up):

   ```bash
   docker compose exec -T postgres \
     pg_dump --format=custom --no-owner --username=oci oci > oci-before-pgvector.dump
   ```

3. Switch the `postgres` service to `image: pgvector/pgvector:pg17` **and** to a
   new, empty volume (for example `postgres_data_pgvector:/var/lib/postgresql/data`,
   declared under `volumes:`), keeping the same `POSTGRES_*` settings. Keep the
   old volume until the new database is verified.
4. Start the new server and restore into the database its entrypoint created:

   ```bash
   docker compose up -d postgres
   docker compose exec -T postgres \
     pg_restore --no-owner --role=oci --username=oci --dbname=oci < oci-before-pgvector.dump
   docker compose exec -T postgres psql --username=oci --dbname=oci \
     -c 'CREATE EXTENSION IF NOT EXISTS vector;'
   ```

5. Start the API (`docker compose up -d`), sign in, and check conversations,
   search and attachments before removing the old volume.

*Option 2: build pgvector into the Alpine image you already run.* The data
directory and its collation stay as they are, so no dump and restore is needed.
A minimal Dockerfile:

```dockerfile
FROM postgres:17-alpine
ARG PGVECTOR_VERSION=0.8.6
RUN apk add --no-cache --virtual .build-deps build-base git \
 && git clone --depth 1 --branch "v${PGVECTOR_VERSION}" \
      https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && cd /tmp/pgvector \
 && make OPTFLAGS="" with_llvm=no \
 && make install with_llvm=no \
 && cd / && rm -rf /tmp/pgvector \
 && apk del .build-deps
```

Build it, set the `postgres` service's `image:` (or `build:`) to it, recreate the
container on the same volume, and run the `CREATE EXTENSION` command above.
`OPTFLAGS=""` keeps the build portable across CPUs; `with_llvm=no` skips the
optional JIT bitcode, which would otherwise need clang and llvm.

OCI never searches across projects, so vectors are compared by an exact scan of
one project's passages; no vector index is created or needed.

#### Reranking (no migration)

Optional reranking of project search is an instance setting only; it needs no
migration and no pgvector. It is off until an administrator chooses a
reranking model under **Providers & Models → Embeddings → Reranking**
([Reranking](admin/models-providers.md#reranking)). The API then calls the
provider's `<base URL>/rerank` from the API containers once per searched
message, so allow that egress if you restrict it. Each call waits at most five
seconds; failures are logged as `Reranking project passages failed; using the
previous order` and never fail a reply.

#### Backups, webhooks and observability (migration 0030)

Migration `0030_backups_webhooks` creates four new, empty tables
(`backup_run`, `backup_object_checksum`, `webhook_endpoint`,
`webhook_delivery`). It rewrites and locks nothing existing, and v0.8 replicas
never read them.

- **The API image now includes the PostgreSQL 17 client tools** (`pg_dump`,
  `pg_restore`, from Alpine's `postgresql17-client`), used by automated
  backups. They run as the image's non-root `oci` user. A PostgreSQL 18 server
  needs newer tools; outside the image, set `BACKUP_PG_BIN_DIR` if they are not
  on `PATH`. Automated backups are off until turned on under **Data & storage
  → Backups** ([Backups](admin/backups.md)); the API needs egress to the
  backup bucket.
- **Metrics** are served at `/metrics` on each API replica only when
  `METRICS_TOKEN` is set, and **traces** are exported only when
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set
  ([Observability](admin/observability.md)). Neither changes anything by
  default; the bundled Caddy proxy does not forward `/metrics`.
- **Webhooks** under **Tools & integrations → Webhooks** send selected audit
  events from the API to your endpoints; allow egress where it is filtered.
  Delivery runs in the `webhooks.deliver` job, so it needs the background jobs
  that already run on every replica.

#### Dropped `user_preference.boring_mode` (migration 0031)

Migration `0031_drop_boring_mode` drops the unused `user_preference.boring_mode`
column, the second step of a two-release removal
([Removing a column](dev/database.md#removing-a-column)). v0.8 no longer reads
or writes it, so v0.8 replicas keep working while the migration applies and
during a rolling replacement. The drop changes only the catalog (no table
rewrite) under a brief exclusive lock on `user_preference`. v0.7 and earlier
still read the column, so when upgrading straight from v0.7, stop the old
replicas before migrating rather than replacing them one by one. The drop is
not reversible by reverting images: running v0.7 again would need the column
re-added (`boolean NOT NULL DEFAULT false`).

#### Artifacts (migration 0032)

Migration `0032_artifacts` creates two new, empty tables, `artifact` and
`artifact_version`, cascading from the thread, the user and the reply that
made them; it rewrites and locks nothing existing, and v0.8 replicas never read
them. Artifact versions count towards each person's storage allowance.

HTML and SVG artifacts run in a sandboxed frame loaded from
`/artifact-frame.html`, a static file of the web image. The bundled Caddy
configuration serves that one path with its own Content-Security-Policy
(`sandbox allow-scripts`, inline code and `data:` images only, no network,
`frame-ancestors 'self'`) and without `X-Frame-Options: DENY`; every other
response keeps the application policy. **If you run your own reverse proxy**
and it adds a policy or `X-Frame-Options` to every response, exempt that path
in the same way, or artifact previews stay blank (the rest of OCI is
unaffected). Send the same policy for it, including `sandbox allow-scripts`
and `frame-ancestors 'self'`. The page also protects itself: it writes nothing
unless it is framed with an opaque (sandboxed) origin, so a proxy that sends
no policy for it cannot make it run code on OCI's origin. The
switches are per role (**Artifacts**) and, for the diagram guidance, on
**General** ([Governance](admin/governance.md#artifacts)).

#### User memory (migration 0033)

Migration `0033_user_memory` creates one new, empty table, `user_memory`
(cascading from the user; its conversation and message references become null
when those are deleted), and adds `user_preference.memory_enabled`
(`boolean NOT NULL DEFAULT false`), a catalog-only change under a brief
exclusive lock on `user_preference`. v0.8 replicas name their columns, so they
neither read nor write either and keep working during a rolling upgrade. Memory
stays off until an administrator switches on **General → User memory**
([Instance settings](admin/instance-settings.md#general)); each person must
then opt in. Notes are part of the database backup and of each person's
export; the `retention.memories` job deletes old ones only when **Memory
retention** is set ([User memory](admin/governance.md#user-memory)).

#### Compliance export and legal hold (migration 0034)

Migration `0034_compliance` creates three new tables (`legal_hold`,
`compliance_export_run`, `compliance_export_cursor`) and changes two existing
ones:

- `audit_log` gains a `seq` column. Existing entries are numbered once, in time
  order, while the migration holds an exclusive lock on `audit_log`, so the
  time it takes (and the time audit writes wait) grows with the size of the
  audit log; on a very large log, shorten audit retention first or migrate in
  a quiet period. The column has a default, so v0.8 replicas keep writing
  audit entries during a rolling upgrade.
- `message` gains a nullable `change_seq` column (no rewrite), an index on it
  and a trigger that sets it on every insert and content change. Existing
  messages keep NULL. Building the index scans `message` once and blocks
  message writes while it does.
- A trigger on `user` refuses to delete an account on legal hold, whichever
  path tries.

The export is off until turned on under **Data & storage → Compliance**
([Compliance export and legal hold](admin/compliance.md)); it needs egress to
its bucket, like backups. Conversation content is exported only if an
administrator also turns that on.

#### File output (no migration)

Replies and Markdown artifacts can be downloaded as DOCX, PDF, XLSX or PPTX
([Exporting as files](user/exporting.md)). The API image gains four runtime
dependencies, all MIT and pure JavaScript (no headless browser, no native
code): `docx`, `pdfkit`, `pptxgenjs` and `markdown-it`; spreadsheets are
written with `fflate`, already a dependency. Nothing reaches the network:
images are never fetched and PDFs use the built-in standard fonts.

Each document is generated in a worker thread of the API process, started for
the request and stopped after it, with a 512 MB heap limit and a 60-second time
limit (content that exceeds either is refused with a 422, not retried). A
replica runs at most two at once and one per person; further requests get a
429 asking to retry shortly. Budget up to two CPU cores and about 1.2 GB of
extra memory per API replica for exports at peak, on top of what it uses today; the
event loop is not blocked while a file is generated. Downloads count towards a
per-person allowance of 60 an hour, shared with single-conversation Markdown
downloads (which had no limit before), in the existing rate-limit store. Each
export is audited as `message.export` or `artifact.export` with the format and
size, never the content.

### Upgrading to v0.10

#### Backups include files (migration 0035)

Migration `0035_backup_files` adds six nullable columns to `backup_run`
(what each run copied, skipped, read back and swept). It is catalog-only under
a brief exclusive lock on `backup_run`, a small table only the backup job
writes; v0.9 replicas name their columns and keep working during a rolling
upgrade.

Backups can now copy attachment files (and the uploaded instance logo) to the
backup destination, under `<prefix>objects/<sha256>`
([Attachment files](admin/backups.md#attachment-files)):

- **Instances that saved backup settings before v0.10 keep the old behaviour**
  (a manifest, no copies) until an administrator turns on **Copy attachment
  files**: the first copy can be as large as all attachment storage, and should
  be a decision, not a side effect of an upgrade. A new configuration has it on.
  The Backups page says when files are not copied.
- The first backup after turning it on reads and copies every attachment
  object, so it takes longer and uses as much storage again as attachments use
  now (at the backup destination; in the attachment bucket itself with the
  *Attachment storage bucket* destination). Later backups copy only new files.
  Plan bucket capacity and egress accordingly.
- The backup credential now also needs `s3:ListBucket` on the prefix: after
  retention, copies no kept backup references are found by listing
  `objects/` and deleted (only once they are a day old).
- A bucket and prefix belong to one OCI instance: never point two instances'
  backups at the same prefix, or one's sweep deletes the other's copies.

#### Default model and reasoning level per person (migration 0036)

Migration `0036_personal_defaults` adds one nullable column,
`user_preference.default_effort`, with no default: catalog-only under a brief
lock, no table rewrite, safe to apply before the new release is deployed.
v0.9 replicas ignore it. Every existing person keeps starting from the
instance defaults until they choose their own under Settings → Models.

The composer no longer reads the last model picked from the browser
(`oci.model` in local storage); the first visit after the upgrade removes it.
People who relied on it start from the instance default, or the default they
save, on every device.

Also in v0.10 without a migration: Settings → Sharing, and the **Delete own
account** role switch, which is off for every role after the upgrade (see
[Self-service account deletion](admin/governance.md#self-service-account-deletion)).

## Usage accounting after an interrupted run

Migration `0021_usage_settlement` marks new incomplete reports with
`usage_unknown` and widens daily token aggregates to `bigint`. Every new chat
attempt has a usage-event ID equal to its run/assistant ID, even without an
applicable quota. Prices are snapshotted before generation.

Settlement and daily rollup commit together. Repeated complete reports cannot
add another message. Partial reports merge cumulative counts without erasing
previous actuals; a complete report replaces them, including downward corrections.
Unresolved events are exempt from normal usage-event pruning until reconciled,
retaining their identity and price snapshot. This does not extend their quota
window, and account deletion still erases the account's usage history.
A sweep processes at most 200 old unclaimed events,
with one short transaction per event, and skips active matching assistant rows.
It records uncertainty, not measured zero or proof that an old producer stopped.

Quota meters retain the remaining configured estimate for unknown usage within
the policy window. Daily reports include only reported amounts, not that held
estimate. The reservation age alone no longer forgives uncertain spend.

- Confirm the producer has stopped before recovering its chat claim.
- Never clear usage events or edit daily totals merely to unblock a conversation.
  For a proven never-started attempt, use the transactional reservation-release
  service in reviewed maintenance code; for actual usage, use the settlement
  service with verified provider totals and the exact event owner/model.
- Investigate an unknown event against provider records before treating it as
  free. An audited quota override may be appropriate while usage is unresolved.
- These changes do not reconstruct historical lost rollups or classify older
  zero-usage settlements. Do not rebuild long-lived daily totals from a partially
  retained event history: that would discard legitimate older usage.

## Recovering an interrupted upload

Migration `0020_atomic_upload_admission` adds durable upload reservations and a
counter-release trigger for attachment deletion, including cascades. Drain old
API producers before migrating and deploying: old versions do not honor upload
reservations. Back up the database and objects together before upgrading.

An attachment with `upload_pending = true` reserves capacity but cannot be listed,
read or sent. There is no timeout takeover: a slow upload is not proof of a crash.
An interrupted upload can therefore retain its allowance until explicitly removed.

1. Confirm the upload producer has stopped. If ownership is uncertain, drain and
   stop all API/worker replicas. Do not clear reservations while a writer can
   still publish their objects.
2. Inspect the affected owner's `attachment` rows with `upload_pending = true`.
   Check the exact ID, owner and object key, not merely its age.
3. Delete only the confirmed abandoned reservation in a maintenance session:

   ```sql
   -- Replace both placeholders with the inspected values.
   DELETE FROM attachment
   WHERE id = 'REPLACE_WITH_ATTACHMENT_ID'
     AND user_id = 'REPLACE_WITH_OWNER_ID'
     AND upload_pending = true
   RETURNING id;
   ```

   The delete triggers release its counters and durably queue its object for
   removal. They do not delete completed attachments or require object storage
   to be reachable. Legacy rows whose key is literally `pending` have no known
   object key; orphan reconciliation can identify their unreferenced objects
   after its safety window.
4. Restart producers and run storage reconciliation (**System health → Storage
   reconciliation**), counter rebuilding and the object reaper as appropriate. Do not flush storage or zero counters manually.

## When live replay is unavailable

Redis holds an approximately 10,000-event window, not a complete durable
transcript. Replay checks versioned event sequences before forwarding them to
the AI SDK. If a prefix or later range was trimmed, the cache expired, or capture
failed, it reports that live replay is unavailable instead of sending orphan
text/reasoning deltas. Old unversioned caches also fail closed.

Reload the conversation to retrieve saved messages. A response can still be
running: losing replay does not cancel the producer, release its PostgreSQL
claim, or prevent the final answer from being saved. Use an explicit stop or
wait for completion; do not clear claims based on missing cache data. Network
partitions can prevent Redis from recording its final state, so cache metadata
alone is not proof of producer liveness or completion.

Before opening replay, the API checks the exact cached assistant/run against its
owned, live PostgreSQL thread. Missing or terminal runs return no replay (204),
so the client can load saved history. A failed durable validation returns a safe
503 instead of pretending the run is absent. Already-idle readers recheck every
two seconds. Missing ownership or validation failure ends only that reader with
the friendly replay error. For an owned terminal run, the reader refreshes a
bounded cache-tail snapshot: it closes cleanly only after forwarding a real SDK
finish frame, otherwise it reports unavailable replay. This covers completion
that arrives during the status check or before delayed cache finalization,
without following an indefinitely growing cache or fabricating completion.
Each validation has a two-second reader deadline, a one-second SQL statement
timeout, and abort checks before queued work proceeds.
The reader deadline does not itself cancel a queued database transaction.

A successfully acquired PostgreSQL claim may replace stale Redis indexing with
conditional publication. A racing index change makes the new response
non-resumable, not rejected; same-run retries never reset cached events,
cancellation or TTLs. This does not delete old cache data or reclaim a streaming
PostgreSQL claim, and does not guarantee Redis finalization during a partition.

Replay readers apply backpressure and buffer at most one 200-event Redis batch
plus one queued chunk. These are event-count bounds, not byte/RSS guarantees.
The drained rollout below also avoids mixed replay protocol versions.

## Recovering an interrupted chat run

Chat admission is coordinated in PostgreSQL, even when Redis is unavailable.
A streaming assistant row claims its thread until completion is persisted.
Admission does not assume a run is dead just because it is over 15 minutes old.

**Before rolling out this admission change, drain and stop old API producers.**
Mixed old/new versions do not share the same admission protocol. Normal client
disconnection is not proof that a model stopped; do not clear a claim merely
because Redis is empty or its TTL elapsed.

If a crashed producer leaves a thread blocked:

1. Positively stop its producer. If ownership is uncertain, drain/stop **all** API
   and worker replicas before proceeding. An abort request alone is not proof.
2. Inspect the affected thread and streaming assistant ID in PostgreSQL. New
   assistant claim IDs also identify their runs in application logs.
3. In a maintenance database session, repair **only those exact IDs**. For
   example, using psql variables after replacing the placeholders:

   ```sql
   \set thread_id 'REPLACE_WITH_THREAD_ID'
   \set assistant_id 'REPLACE_WITH_ASSISTANT_ID'
   BEGIN;
   SELECT id FROM thread WHERE id = :'thread_id' FOR UPDATE;
   -- No prompt was committed for a parentless provisional claim.
   DELETE FROM message
   WHERE id = :'assistant_id' AND thread_id = :'thread_id'
     AND role = 'assistant' AND status = 'streaming'
     AND parent_message_id IS NULL;
   -- Retain committed prompts, attachments and any partial response.
   UPDATE message SET status = 'error', updated_at = now(),
     error_message = 'Generation interrupted; recovered after producer shutdown'
   WHERE id = :'assistant_id' AND thread_id = :'thread_id'
     AND role = 'assistant' AND status = 'streaming';
   COMMIT;
   ```

4. If Redis still has `oci:chat-stream:thread:THREAD_ID:active`, remove only that
   thread's stale pointer while producers remain stopped, or wait for its TTL.
   Do not flush Redis or delete user messages. Existing quota-reservation
   recovery remains separate; do not delete usage records to unblock a thread.
5. Restart producers, then retry the affected conversation.

This is fail-closed recovery, not a lease or automatic fencing mechanism.

## Getting back in when sign-on fails

Two settings can make an instance unreachable through the identity provider,
and both have a way around them. Confirm the route works before enabling either
in production.

- **The sign-in form is skipped.** A provider set to redirect sends every
  visitor straight to it. `/auth/login?local=1` suppresses that and shows the
  form, which is the way in if the provider is down or misconfigured.
- **A login is refused for want of a role.** With `require_role_match` on, a
  user matching no mapping is refused rather than admitted with the default
  role. An administrator locked out this way signs in locally with the account
  seeded at installation, or one promoted with the recovery CLI.

Local sign-in for an administrator is deliberately preserved. Turning off local
authentication still admits a verified administrator, precisely so that setting
cannot lock everybody out — but it depends on at least one administrator
account having a verified email and a password that somebody knows. Check that
before disabling it.

If nothing above works, the recovery CLI promotes an existing account:

```bash
docker compose exec api node dist/scripts/promote-admin.js user@example.com
```

Outside a container, from a checkout: `pnpm --filter @oci/api admin:promote
user@example.com`.

## Single sign-on roles

A user's role is recalculated from identity-provider claims on every SSO
sign-in, then written to their account.

Two consequences follow, and both surprise administrators who have not met them
before:

- **A role set by hand does not persist.** Promoting an SSO user in the admin
  interface lasts until their next sign-in, at which point the mapping wins.
  Grant a lasting role by changing the group membership in the identity
  provider, or by mapping the group they are already in.
- **A role can go down as well as up.** Someone removed from a mapped group
  drops to whatever still matches, or to the provider's default role.

Where a user matches several mappings, the most privileged one wins. Ordering
the rows differently will not change the outcome; that is deliberate, so a
privilege does not depend on the order somebody happened to add the rows.

To audit what an instance will do before enabling a provider, read its
`claimRoleMappings` and remember that every mapping is evaluated, not just the
first that matches.

## Rollback and recovery

Application images can be rolled back by restoring `OCI_API_IMAGE` and
`OCI_WEB_IMAGE` to the previous versioned tags. Database migrations are forward
only unless a release explicitly documents otherwise. If an upgrade migration
is incompatible with the previous application version, restore the pre-upgrade
PostgreSQL backup and matching attachment snapshot before starting the previous
images.

Do not rotate `ENCRYPTION_KEY` as part of a routine rollback. A different key
cannot decrypt credentials written with the original key.
