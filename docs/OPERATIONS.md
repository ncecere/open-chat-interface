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
export OCI_VERSION=v0.8.0
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
