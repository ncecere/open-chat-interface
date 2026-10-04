# Scale harness

The scale harness (v0.11 design, section 10) answers "how does OCI behave with
a large deployment's data and load?" with numbers instead of guesses. It
generates a deterministic, realistic dataset of a chosen size, runs OCI's real
images against it, puts it under load with [k6](https://k6.io/), and reports
latency per scenario, background job throughput, and what the database spends
its time and disk on. Every later v0.11 decision (indexes built concurrently,
usage rollups, vector generations, whether Qdrant is needed) should cite a run.

Everything lives in `tools/scale/`; `.github/workflows/scale.yml` runs it in CI.

## What a run does

`tools/scale/run.sh --profile small` performs, in order:

1. **Preflight**: checks Docker, records the hardware, and refuses to start if
   Docker's disk has less than 1.5 times the profile's estimated size plus
   10 GB free (tiny 11 GB, small 15 GB, medium 40 GB, large 125 GB).
2. **Build** the API and web images from the checkout (`docker/api.Dockerfile`,
   `docker/web.Dockerfile`), tagged `oci-scale-api:local` and
   `oci-scale-web:local`.
3. **Start** its own compose project, `oci-scale` (`tools/scale/compose.yaml`):
   PostgreSQL 17 with pgvector and `pg_stat_statements` (`pgvector/pgvector:pg17`),
   Redis, and the stub model. Host ports are bound to 127.0.0.1 only: web
   18080, PostgreSQL 15432, stub 14181 (`SCALE_WEB_PORT`, `SCALE_PG_PORT`,
   `SCALE_STUB_PORT`).
4. **Migrate** with the API image's `node dist/migrate.js`, exactly as a
   deployment's migrate job does.
5. **Generate** the dataset (`tools/scale/generate.mjs`, run inside the API
   image so the host needs no Node packages).
6. **Start** N API replicas (`--replicas`, `RUN_MIGRATIONS=false`) behind the web
   container. Its Caddy re-resolves `api` every 10 seconds, so every replica
   receives traffic.
7. **Warm up** for 20 seconds (not measured), then reset `pg_stat_statements`.
8. **Main run** (`tools/scale/k6/main.js`): a sign-in storm, then a mixed steady
   state of every scenario at once.
9. **Collect** (`tools/scale/report.mjs collect`): database and table sizes,
   dead tuples, largest indexes, `pg_stat_statements` top and named queries,
   job runs, the indexing and embedding backlog, a direct pgvector probe, and
   every replica's Prometheus metrics.
10. **Retention phase** (`tools/scale/k6/retention.js`, skip with
    `--skip-retention`): an administrator runs usage-event and audit-log
    retention, pruning the oldest quarter of each, while people keep browsing.
11. **Report**: `tools/scale/results/<profile>-<date>.md` and `.json`, with raw
    files (k6 summaries, generator report, fixtures, collected measurements)
    in `tools/scale/results/<profile>-<date>/`.
12. **Tear down** its own project and volumes only (`docker compose -p oci-scale
    down -v`), unless `--keep`. Other compose projects are never touched.

## Profiles

Profiles are defined in `tools/scale/profiles.mjs`. The first seven rows are
exact: the generator writes precisely these numbers. The rest follow from them;
the figures are from the baseline runs (seed `oci-scale`) and are an estimate
for `large`, which has not been run yet.

| | tiny | small | medium | large |
| --- | ---: | ---: | ---: | ---: |
| People | 50 | 1,000 | 6,000 | 30,000 |
| Conversations | 1,000 | 50,000 | 400,000 | 2,000,000 |
| Messages | 10,000 | 500,000 | 4,000,000 | 20,000,000 |
| Usage events | 2,500 | 125,000 | 1,000,000 | 5,000,000 |
| Audit entries | 2,500 | 125,000 | 1,000,000 | 5,000,000 |
| Projects | 20 | 800 | 6,000 | 30,000 |
| Project files | 100 | 5,000 | 40,000 | 200,000 |
| Passages (`project_file_chunk`) | 1,042 | 54,189 | 437,363 | ≈ 2.2 M |
| Embeddings (1536 dimensions) | 1,001 | 49,682 | 389,609 | ≈ 2.0 M |
| Attachments (message files + project files) | 234 | 12,487 | 100,687 | ≈ 500,000 |
| Daily usage rollups (`usage_record`) | 1,065 | 43,921 | 335,772 | ≈ 1.7 M |
| Share links | 28 | 1,213 | 8,819 | ≈ 45,000 |
| Database after generation | 0.05 GB | 1.7 GB | 13.4 GB | ≈ 70 GB |
| Generation time (M4 Pro, see below) | 2 s | 49 s | 7.5 min | ≈ 45 min (est.) |

Load per profile, as concurrent virtual users (VUs). Each VU is one signed-in
person with think time between actions (1–8 s, depending on the scenario):

| | tiny | small | medium | large |
| --- | ---: | ---: | ---: | ---: |
| Sign-in storm (sign-ins per second, hold) | 5/s, 10 s | 20/s, 45 s | 40/s, 60 s | 80/s, 120 s |
| Steady state duration | 40 s | 3 min | 5 min | 10 min |
| Browsing (sidebar, then a conversation) | 4 | 20 | 40 | 80 |
| Chatting with the stub model | 2 | 10 | 20 | 40 |
| Keyword search | 2 | 5 | 10 | 20 |
| Project chat (half in large projects) | 2 | 4 | 8 | 16 |
| Administrator reading reports | 1 | 1 | 2 | 2 |
| Administrator running indexing and embedding jobs | 1 | 1 | 1 | 1 |
| Browsing during the retention phase | 2 | 10 | 20 | 40 |

## The dataset

`generate.mjs` is deterministic: the same `--profile`, `--seed` and `--now`
produce identical rows. Every entity draws from its own random stream keyed by
its index, so eight worker threads generate slices in parallel without
coordinating, each through `COPY ... FROM STDIN` on its own connections
(binary `COPY` for the vectors). For speed it drops the secondary indexes of
the tables it loads (saving their definitions in a table, so an interrupted
run restores them on the next start), loads with
`session_replication_role = replica`, rebuilds the indexes with three parallel
builders, runs `VACUUM (ANALYZE)`, and then checks every foreign key with
anti-joins and fails if any row is orphaned. It therefore needs a superuser on
a disposable database, refuses a database that already has people unless given
`--reset`, and must never be pointed at a real deployment.

What the data looks like:

- **People**: `person<N>@scale.test`, plus `admin@scale.test`; 0.2% admins, 1%
  auditors, 3% restricted, 0.4% banned, all verified. A third joined in the
  first weeks after "launch" a year before `--now`, the rest over the year.
  Everyone signs in with one password (`scale-harness-password`, or
  `--password`) through a single precomputed hash in Better Auth's format
  (`account.password` = `<hex salt>:<hex scrypt key>`, N=16384, r=16, p=1,
  64 bytes, password NFKC-normalised), so sign-in does the real scrypt work.
  60% have an existing session; 75% have preferences.
- **Conversations per person** are Pareto-distributed (8% never chatted; at
  `small` the median is 20 and the busiest person has 752). **Messages per
  conversation** are log-normal with a minimum of 2 and a cap of 600 (median
  6, p90 20, p99 about 50). Messages alternate user and assistant; an odd count
  includes a retried reply (`superseded_at` set on the replaced one, both
  pointing at the prompt through `parent_message_id`). Replies take seconds,
  the next turn follows after about a minute, occasionally days later;
  conversations start between the person's joining and now, weighted towards
  recent activity.
- **Message `parts`** are shaped like the API's: user messages are a `text`
  part plus `data-attachment` parts for files; replies are `step-start`,
  `reasoning` (for the reasoning model), `source-url` parts when web search was
  used (3%), and a Markdown `text` part (headings, lists, code, tables) about
  900 characters at the median. 0.5% errored and 0.3% cancelled replies carry
  partial text. `tokens_in` grows with the conversation (capped at the model's
  128k window); `tokens_out` and `duration_ms` follow the reply length.
- **Text** comes from a Zipf-distributed vocabulary: a few hundred common
  English words, then invented words, so full-text search sees a handful of
  words everywhere and a long tail of rare ones. The message search index is
  an expression GIN index (migration 0023), built by the database from
  `parts`; the passage `search` column is a generated column, also filled by
  the database during `COPY`.
- **Flags**: 3% pinned, 6% archived, 1.5% in the trash (deleted within the last
  25 days, so the purge job leaves them alone), 0.2% temporary (still
  unexpired), 2% imported, 2% shared (10% of links revoked); a third of a
  project user's conversations are in one of their projects. Restricted people
  have no attachments, share links, temporary chats or projects, matching
  their role's defaults.
- **Attachments**: 3% of user messages carry one or two files (PNG, PDF, text,
  Word) as metadata with storage keys in the API's format and extracted text
  for documents. **No stored objects are written**: no scenario downloads
  files, and the storage volume stays empty.
- **Projects and files**: about four in ten people who chat use projects (at
  most ten each); files per project are log-normal (at most 20, the API's
  limit). Each project has three distinctive topic words that recur in its
  files. One project in fifty is a **large project** (handbooks, books) whose
  files are 40–300 passages each, too much to include whole in a model's
  context, so OCI answers from searched passages; the others fit whole. Of the
  files, 3% are images (no text), 8% are not yet chunked (work for
  `projects.index-files`), 9% are chunked but not embedded (work for
  `projects.embed-passages`), and the rest are fully embedded. Passages are cut
  like the API's chunker (about 1,200 characters, 200 overlapping, `content`
  exactly `text.slice(start, end)`).
- **Embeddings** use the hashing trick over words (`lib/embed.mjs`), unit
  length, so passages and questions sharing words are near each other; the
  stub model computes the same function, so embeddings made by the API's job
  and by the generator agree.
- **Usage events** are one per reply, for the newest replies only, exactly as
  many as the profile says: what remains after retention pruned older events.
  Prices are snapshotted from the catalog. **Daily rollups** (`usage_record`)
  cover every reply of the year; `storage_usage` is computed from attachments;
  a few hundred `quota_denial` rows feed the limits report. One enabled
  monthly cost policy applies to the `user` role with a limit no one reaches,
  so admission reads usage as it would with a real budget.
- **Audit entries** are mostly sign-ins (62%), sign-outs, failures, tool calls,
  exports and administrator changes, timestamped in increasing order with
  growing density, and numbered `seq` 1..N in that order (the database
  sequence is advanced past them). Messages written in the last 150 days get a
  time-ordered `change_seq` (older ones keep NULL, as messages written before
  v0.9 do), and the sequence is advanced past them.
- **Catalog**: one OpenAI-compatible provider (the stub) and four models
  (`scale-stub` default, `scale-mini`, `scale-reasoning`, `scale-large`),
  priced, used by conversations at 55/25/15/5%.

### How the embedding table is configured

`project_file_embedding` is created at runtime by the API, never by a
migration (`apps/api/src/services/embeddings/storage.ts`). The generator:

1. enables the extension (`create extension if not exists vector`);
2. creates `project_file_embedding` with the API's exact DDL and a
   `vector(<--dimensions>)` column (default 1536), dropping a table of other
   dimensions;
3. saves the instance setting `embeddings` = `{enabled: true, providerId:
   <stub provider>, modelId: "scale-embed", dimensions: <n>, inputPriceMicros:
   20000}`, so the stored vectors carry the model key the API computes
   (`<providerId>/scale-embed/<n>`).

When the API starts, `ensureEmbeddingTable(n)` finds a table of matching
dimensions and keeps it, meaning-based search is active at once, and the
embedding job only works on the passages left unembedded. `--dimensions`
changes the width (for example 768 or 3072).

## The stub model

`tools/scale/stub/server.mjs` (grown from the browser-performance fixture
provider) is an OpenAI-compatible server:

- `POST /v1/chat/completions` streams `STUB_REPLY_TOKENS` (250) tokens of
  about four characters after `STUB_FIRST_TOKEN_MS` (500 ms), paced at
  `STUB_TOKENS_PER_SECOND` (50), and reports usage; non-streaming requests
  (titles, summaries) answer after the first-token delay. A reply takes about
  5.5 seconds.
- `POST /v1/embeddings` returns the hashing embeddings after
  `STUB_EMBEDDING_DELAY_MS` (40 ms).
- `GET /marks/<id>` returns when the request carrying `[scale:<id>]` arrived
  and when its first and last tokens left.

That last endpoint is how **reply start added by OCI** is measured. k6 cannot
read a stream incrementally, so each chat message carries a unique marker; k6
records when it sent the request, and the stub records when the model request
arrived. The difference is everything OCI does before the model is asked
(authentication, rate limits, quota admission, saving the turn, loading the
conversation and building the context, project retrieval including the query
embedding), with the stub's own first-token delay excluded by construction.
Both clocks are the same machine's. The relay back is measured separately:
the time from the stub's last token to k6 receiving the end of the stream.

## Scenarios

All requests go through the web container (Caddy), as a browser's do, with
Better Auth's session cookie. Each VU sends `X-Forwarded-For` with its own
address from 198.18.0.0/15 and the harness's web proxy trusts the compose
network (`TRUSTED_PROXIES=private_ranges`), so the API sees one address per
simulated person. The harness raises OCI's own limits
(`RATE_LIMIT_AUTH_PER_MINUTE`, `RATE_LIMIT_CHAT_PER_MINUTE`,
`RATE_LIMIT_MAX_CONCURRENT_STREAMS`), since it measures OCI rather than its
abuse protection.

| Scenario | What a VU does | Measured as |
| --- | --- | --- |
| Sign-in storm | `POST /api/auth/sign-in/email` with a fresh cookie jar, everyone in turn, at a ramping arrival rate | `signin_ms` |
| Browse | The sidebar's requests in parallel (`/api/me`, `/api/threads?view=sidebar`, `/api/models`, `/api/projects/sidebar` for roles with projects), then `GET /api/chat/:id/messages` for a recent conversation | `sidebar_ms` (wall time of the parallel batch), `sidebar_threads_ms`, `conversation_open_ms` |
| Chat | Sends a message to one of the person's recent conversations and reads the stream to the end | `chat_pre_model_ms` (by history size), `chat_ttfb_ms`, `chat_total_ms`, `chat_tail_ms` |
| Project chat | The same in a project conversation, asking about the project's topic words; half the VUs in large projects | `project_pre_model_ms` (searched vs whole files), `project_total_ms` |
| Keyword search | `GET /api/threads/search` with a common, medium, rare or two-word term | `search_ms` by bucket |
| Admin | Overview, usage overview, spend, limits and storage (30 days), users, audit log, system health | `admin_ms` by page |
| Jobs | An administrator runs `projects.index-files` and `projects.embed-passages` through `POST /api/admin/lifecycle/jobs/:name/run`, again and again | `job_ms`, `job_items` |
| Retention | `retention.usage-events` and `retention.audit-log` once each, with windows set to prune the oldest quarter, while browsing continues | `retention_job_ms`, `retention_items`, `*_during_retention_ms` |

**Targets** are the design's proposals: p95 under 300 ms for the sidebar and
for opening a conversation, under 1 s of reply start added by OCI, and under
1 s for search. They are k6 thresholds, with an error-rate threshold of 1% per
scenario. A missed threshold is **reported, not enforced**: `run.sh` notes it
and exits 0, unless `--enforce` is given.

## Running it

Requirements: Docker with Compose v2 and bash. Nothing else: the generator and
report run in the API image, k6 in its official image (`grafana/k6`; k6 is
AGPL-licensed and is only ever run as a separate container, never vendored or
added as a dependency).

```sh
tools/scale/run.sh --profile tiny           # about 3 min after the image builds
tools/scale/run.sh --profile small          # about 7 min
tools/scale/run.sh --profile medium         # about 20 min, 40 GB of free Docker disk
tools/scale/run.sh --profile small --replicas 3
tools/scale/run.sh --profile small --keep   # leave the stack up to explore
tools/scale/run.sh --profile small --keep --no-generate --no-build  # re-run load on kept data
```

| Option | Meaning |
| --- | --- |
| `--profile` | `tiny`, `small`, `medium` or `large` (default `tiny`) |
| `--replicas N` | API replicas behind the web proxy |
| `--enforce` | Exit non-zero when a target or error threshold is missed |
| `--keep` | Leave `oci-scale` running; remove it later with `docker compose -p oci-scale -f tools/scale/compose.yaml down -v` |
| `--no-build` | Use existing images (`SCALE_API_IMAGE`, `SCALE_WEB_IMAGE`) |
| `--no-generate` | Reuse the data of an earlier `--keep` run |
| `--skip-retention` | Skip the destructive retention phase |
| `--seed`, `--dimensions` | Passed to the generator |

Environment: `STUB_FIRST_TOKEN_MS`, `STUB_TOKENS_PER_SECOND`,
`STUB_REPLY_TOKENS`, `STUB_EMBEDDING_DELAY_MS`; `SCALE_PG_SHARED_BUFFERS` (1GB),
`SCALE_PG_EFFECTIVE_CACHE_SIZE` (3GB), `SCALE_PG_WORK_MEM` (16MB),
`SCALE_PG_MAINTENANCE_WORK_MEM` (512MB); `SCALE_PROJECT` (`oci-scale`).

The generator also runs on its own against any migrated, empty database you
own (with `pnpm install` done, or inside the API image):

```sh
node tools/scale/generate.mjs --profile small --database-url postgres://oci:...@127.0.0.1:15432/oci \
  --stub-url http://127.0.0.1:14181/v1 --out /tmp/scale
```

While a kept stack is up, the web app is at http://127.0.0.1:18080 (sign in as
`admin@scale.test` or any `person<N>@scale.test` with the harness password)
and PostgreSQL at `postgres://oci:oci-scale@127.0.0.1:15432/oci`.

## In CI

`.github/workflows/scale.yml`:

- **Weekly** (Mondays 05:17 UTC) at `small` on a hosted `ubuntu-24.04` runner
  (the repository is public, so hosted minutes are free), and **on demand**
  with inputs for the profile (default `small`), API replicas, runner label and
  `enforce`.
- The report is added to the job summary and every result file is uploaded as
  an artifact for 90 days.
- `tiny` takes a few minutes plus the image builds and works as a smoke check.
  `medium` needs 40 GB of free disk, which hosted runners do not reliably
  have; `run.sh`'s disk check refuses it there.
- **`large` needs a self-hosted runner** (125 GB free, several hours):
  pass its label as `runner`. The workflow refuses `large` on an `ubuntu-*`
  label and never defaults to it.

## Baseline

Hardware: Apple M4 Pro (`sysctl -n machdep.cpu.brand_string`), 12 cores, 48 GB
memory, macOS 26.6; Docker Desktop 29.8.1 (linux/arm64 VM) with 12 CPUs and
7.7 GB memory. PostgreSQL ran with `shared_buffers=1GB`. PostgreSQL, Redis, one
API replica, web, stub and k6 all shared that machine, as did other agents'
compose stacks (another OCI upgrade test was running), so the absolute numbers
include contention and are pessimistic for a dedicated server; their
proportions are what matter. Commit `d31bfe1` (v0.10.2), 2026-10-04, seed
`oci-scale`, one API replica. Full reports:
[`baseline-small.md`](../../tools/scale/results/baseline-small.md),
[`baseline-medium.md`](../../tools/scale/results/baseline-medium.md) (and
`.json`).

Generation: `COPY` loads about 100,000 messages a second at `small` and
75,000 at `medium` (120,000–160,000 rows a second across tables). The whole
`medium` generation took 447 s, of which 363 s was rebuilding
`message_text_search_idx`.

p95 latency in milliseconds (p50 in brackets):

| Scenario | Target | small | medium | Met |
| --- | ---: | ---: | ---: | :---: |
| Sidebar (parallel requests) | < 300 | 10 (5) | 68 (9) | yes |
| Open a conversation | < 300 | 5 (3) | 42 (5) | yes |
| Reply start added by OCI, chat | < 1,000 | 142 (18) | 400 (37) | yes (medium p99 1,847) |
| Reply start added by OCI, project chat, files whole | < 1,000 | 156 (19) | 541 (66) | yes |
| Reply start added by OCI, project chat, large project (passages searched) | < 1,000 | 773 (753) | 2,406 (1,476) | **no** at medium |
| Keyword search, all terms | < 1,000 | 79 (18) | 718 (102) | yes (medium p99 1,658) |
| Keyword search, common word | | 87 | 828 | |
| Sign-in (storm at 20/s and 40/s) | | 65 (60) | 68 (64) | |
| Admin: overview | | 147 | 2,804 | |
| Admin: usage overview | | 83 | 2,591 | |
| Admin: usage spend | | 96 | 1,550 | |
| Admin: users, audit, health | | 5–35 | 30–290 | |

Error rate was 0% in every scenario of both runs. Background jobs under load
at `medium`: `projects.index-files` indexed about 74 files per busy second
(50 a run, 0.5–1.8 s a run), `projects.embed-passages` about 150 passages per
busy second (512 a run, 3.3–4.6 s a run, with the stub's 40 ms per batch).
Retention at `medium` deleted 150,090 usage events in 1.0 s and 125,767 audit
entries in 0.5 s, each in one statement, with browsing p95 at 14 ms while they
ran.

pgvector exact scans, timed with `EXPLAIN ANALYZE` on the API's own statement
after the main run:

| Scope | small | medium |
| --- | ---: | ---: |
| Largest project (about 2,750–2,900 passages, 18–20 files) | 18 ms (max 72) | 20 ms (max 64) |
| In-app vector retrieval, mean (max), from `pg_stat_statements` | 9 ms (14) | 64 ms (383) |
| Every embedding, no project filter (top 10) | 247 ms (60,917) | 1,926 ms (408,041) |

## Findings

1. **The sidebar, conversation opening, plain chat and keyword search meet the
   proposed targets at `small` and `medium`** on a shared laptop, with a lot of
   room at `small`. Their medium p99s (sidebar 531 ms, chat reply start
   1.8 s, search 1.7 s) show the tail under CPU contention; a dedicated server
   should do better, and `large` must be run on one before the targets can be
   called met at `large`.
2. **Project chat in a large project misses the 1 s reply-start target, and
   the cause is the keyword ranking query, not pgvector.** `rankProjectChunks`
   (`apps/api/src/services/project-search/retrieval.ts`) took 0.6 s on average
   at `small` and 1.0 s (max 2.1 s) at `medium`, the slowest statement by
   total time at `small` and second only to conversation search at `medium`,
   while the vector scan of the same project took 9–64 ms. `EXPLAIN ANALYZE` shows why: its `total` CTE
   (`select count(*) from scope`) is inlined and re-evaluated for every hit,
   so the cost is passages × hits (18 M rows visited for a 2,751-passage
   project). Declaring it `total as materialized (...)` took the same query
   from 1,491 ms to 46 ms. A one-word product fix worth making before
   anything else in this list. `project_file_chunk_search_idx` was never used
   (0 scans) because the scope is materialized first; at these project sizes
   that is fine once the CTE is fixed.
3. **pgvector exact scans meet the search target at every measured size, and
   no approximate index is needed for per-project search** (input to
   sections 7 and 8). Retrieval is always filtered to one person's project, so
   its cost depends on the project, not on the database: 18–20 ms for the
   largest projects at both `small` and `medium` (about 2,800 passages; the
   API's limits allow up to 20 files of 2,000 passages, 40,000, which would
   extrapolate to roughly 300 ms). An unscoped scan grows with the whole
   table: 1.9 s over 408,000 embeddings, so about 10 s at `large`'s ~2 M. An
   HNSW index only matters if a search ever spans projects or people, and a
   filtered HNSW search would then need iterative scans. On this evidence
   Qdrant is not needed for v0.11; ship the `VectorStore` interface and
   generations with pgvector.
4. **Admin and usage reports scale with the raw tables and will be several
   seconds at `large`.** The overview counts messages by day with sequential
   scans (`message` has no index on `created_at`): 1.4–1.8 s per query at
   4 M messages, about 2.8 s for the page. The usage pages aggregate
   `usage_event` directly: 1.1–1.6 s per query at 1 M events. Both grow
   linearly (about 5× at `large`, so roughly 10–15 s a page). This makes
   **Further scale work 18 (usage rollups) the first of 18–22 to do**, and
   extends it: the overview's message counts need the same daily rollup (or an
   index on `message.created_at`) rather than counting 20 M rows per view.
5. **Keyword search cost follows the person's history, not the database.** The
   statement filters the global message GIN index by person, and for people
   with many messages PostgreSQL instead recomputes `to_tsvector` over every
   one of their messages: 310 ms for the busiest `small` person (about 7,000
   messages) for a common word, with a mean of 177 ms and max 2.1 s at
   `medium`. The busiest `large` people have about 1.5 times as many
   conversations as the busiest `small` one, and real power users may have
   far more. A stored `tsvector` column on `message` (built by a
   background migration, section 1) would remove the recomputation. Separately,
   OCI's metrics label `/api/threads/search` as `/api/threads/:id`.
6. **Sign-in storms are CPU-bound and fine per replica**: scrypt makes each
   sign-in 60–65 ms, flat from 20 to 40 sign-ins a second on one replica.
   **Better Auth's own in-memory rate limiter is on in production** (three
   sign-ins per address per ten seconds, per replica, independent of
   `RATE_LIMIT_AUTH_PER_MINUTE`): before the harness gave each simulated
   person an address, most of the storm got 429s. Many people behind one NAT
   address (a campus on its first morning) would hit the same wall, and with
   several replicas the limit is per replica. Item 22 should configure or
   replace it with the per-identity-provider limits it proposes.
7. **Index builds confirm sections 1 and 2.** Rebuilding the message search
   GIN index took 40 s at 500,000 messages and 363 s at 4 M (about 30 minutes
   at 20 M), with writes blocked throughout if done in a migration
   transaction. Any such index must be built `CONCURRENTLY` in a post-deploy
   step.
8. **Background jobs and retention are not urgent at `medium`.** The embedding
   backlog query (passages without an embedding, an anti-join over every
   passage) took 0.76 s on average at 437,000 passages and runs every five
   minutes; it will be several seconds at `large` and wants an index-driven
   formulation eventually. Retention deleted a quarter of the usage events and
   audit entries in under a second each with no visible effect on browsing,
   so **item 19 (batched retention) matters less than 18 at these sizes**;
   `large` (about 1.25 M rows a run) should be measured before deciding.
9. **Replies and replicas.** Chat reply start grows with load more than with
   history size (short-history p95 was not lower than long-history), which
   points at CPU contention in one API process rather than context building;
   `--replicas` (tested with 3) is the next experiment on a dedicated machine.
   The relay of tokens back added 10–17 ms at the median.

## Usage rollups (v0.11, item 18)

The usage reports and budget checks before and after the hourly usage rollups
(migration 0040, background migration `0.11.usage-rollups`; design in
[database.md](database.md#usage-rollups)). Same machine and datasets as the
baseline (M4 Pro; Docker with 12 CPUs and 7 GiB), stack `oci-scale-rollup`, each
profile generated by `run.sh --keep --skip-retention` with the v0.11 code
before the change, then upgraded in place: `migrate`, replicas replaced,
`migrate --post`, backfill.

**Report pages in isolation** (`tools/scale/k6/reports.js`: one
administrator requests each page back to back on an otherwise idle stack, 30
rounds at `small`, 20 at `medium`; median / p95 in ms):

| Page | `small` before | `small` after | `medium` before | `medium` after |
| --- | ---: | ---: | ---: | ---: |
| Usage, Spend tab, 30 days | 81 / 102 | 7 / 9 | 777 / 809 | 39 / 84 |
| Usage, Spend tab, 90 days | 111 / 126 | 8 / 10 | 1,567 / 1,632 | 43 / 62 |
| Usage, Spend tab, 7 days | 65 / 69 | 5 / 6 | 581 / 608 | 32 / 35 |
| Usage, Overview tab, 30 days | 76 / 82 | 54 / 59 | 828 / 980 | 537 / 612 |
| Admin overview | 125 / 151 | 21 / 24 | 1,172 / 1,335 | 195 / 249 |

- The Spend tab (totals, daily spend, per model, top consumers, idle models)
  and the scheduled report, which runs the same queries, no longer grow with
  usage history: 20 times faster at `medium`, and the 90-day range now costs
  about what the 7-day one does. Under the mixed load of the main run the
  `medium` Spend tab was 1.6 s at p95 before.
- The Overview tab's remaining cost is not usage events: its activity
  counts scan `message` (sent, searched, failed and cancelled messages over
  the range; 49 ms at `small`, 522 ms at `medium`). That wants its own
  rollup or partial indexes; it is the next step for this page.
- The admin overview reads no usage events; it improved because `migrate
  --post` built the `message.created_at` indexes (post-deploy steps 0001 and
  0002), which `run.sh` does not apply on its own.
- The slowest rollup queries left at `medium` are per person: active people
  per day (97 ms), top consumers (35 ms) and active people over the range
  (28 ms), reading about a quarter as many rows as there are events (1 M
  events became 230,827 rows per hour, person and model, 82 MB, and 5,404 per
  hour and model, 1.3 MB). The harness's people send about three messages a
  day, so an hour rarely holds more than one event of theirs; real use in
  sessions folds better.

**Budget check per send** (the statement admission runs for each budget,
`pgbench`, 2,000 runs, mean latency including the round trip):

| Person, window | Before | After |
| --- | ---: | ---: |
| `medium`, heaviest (5,668 events in 30 days), rolling 30 days | 2.26 ms | 0.24 ms |
| `medium`, heaviest, calendar month (4 days in) | 1.56 ms | 0.23 ms |
| `medium`, median (53 events in 30 days), rolling 30 days | 0.09 ms | 0.11 ms |
| `small`, heaviest (2,609 events), rolling 30 days | 0.58 ms | 0.25 ms |
| `small`, median (43 events), rolling 30 days | 0.08 ms | 0.13 ms |

A budget check now costs the window's hours, not the person's events: bounded
for heavy users, slightly more for light ones (three index probes instead of
one), well under a millisecond either way.

**Backfill**: 126,000 events in 64 batches over 10 s at `small`; 1,002,256
events in 502 batches of 2,000 over 293 s at `medium` (each batch marks 2,000
events and folds what its triggers wrote: 349 ms on average, 648 ms at most;
the change log never held more than a few dozen rows). The rollups matched a
`group by` over every event exactly afterwards (0 differing keys of 230,827).

**Write path.** A reservation and its settlement (two transactions, as a
reply makes) from 32 concurrent clients, `pgbench` for 20 s: 2.0 to 3.2 ms
with the triggers and 2.5 ms without them (run-to-run noise on a laptop is
larger than the difference). Updating a shared per-hour, per-model row in the
same transactions instead, as synchronous rollups would, took 17.4 ms (1,836
against 12,842 runs a second): that hot row is why the triggers append to a
change log and a job folds it. Folding 615,000 changes took 1.9 s.

## Limits

- The baseline machine also ran PostgreSQL, k6 and other workloads; treat
  absolute numbers as an upper bound and compare runs on the same hardware.
- One stub model with fixed delays: provider latency, rate limits and failures
  (item 15) are out of scope.
- No stored objects: attachment downloads, thumbnails and exports are not
  exercised. No SSO: the storm uses local sign-in.
- k6 measures HTTP requests, not browsers; the browser-side cost of long
  conversations (item 21) is in `docs/dev/browser-performance.md`.
- Migration duration, lock waits and upgrade duration (also in section 10)
  are not measured yet; the rolling-upgrade tests (section 5) will reuse this
  harness's dataset and load.
- `pg_stat_statements` gives means and maxima, not percentiles; the k6
  numbers are the user-facing percentiles.
