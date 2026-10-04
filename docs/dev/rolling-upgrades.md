# Rolling upgrades

How OCI is upgraded without downtime, and the test that checks it
([v0.11 design](v0.11-design.md), section 5). The test lives in
[`tools/upgrade-test/`](../../tools/upgrade-test/) and runs in CI as
**Rolling-upgrade test** (`.github/workflows/upgrade-test.yml`).

## The promise

Supported path: **from the previous minor release, with no downtime**. Skipping
a minor is supported with a maintenance window unless the release notes say
otherwise.

An upgrade is the documented sequence for a deployment with several API
replicas ([Operations](../OPERATIONS.md#upgrade)):

1. Run the new release's migrate job once (`docker compose --profile tools run
   --rm migrate`, a Kubernetes job, ...). Replicas run with
   `RUN_MIGRATIONS=false`.
2. Replace the API replicas one at a time.
3. Replace the web proxies.

Between steps 1 and 2 the previous release runs on the new schema. That is
only safe because migrations follow the rules in [Database](database.md):
add tables and nullable columns, never rewrite or lock a large table, and
remove a column over two releases.

## What the test does

`node tools/upgrade-test/run.mjs` drives Docker Compose project
`oci-upgrade` (`tools/upgrade-test/compose.yaml`, web on
`127.0.0.1:18480` and `:18481`):

1. **FROM** is a published release, by default the newest stable tag on GHCR
   older than the source's `package.json` version (`--from vX.Y.Z` to choose).
   **TO** is built from the checkout (`docker/api.Dockerfile`,
   `docker/web.Dockerfile`, `OCI_VERSION` = the source version), or given with
   `--to-api` / `--to-web`.
2. PostgreSQL 17 with pgvector, Redis, a stub OpenAI-compatible model that
   streams a reply in about 4 s (`stub-model.mjs`), two FROM API replicas
   (`api-1`, `api-2`, both answering to the DNS name `api` that the web
   proxy's Caddyfile re-resolves) and two FROM web proxies. FROM's own migrate
   job creates the schema.
3. **Data.** Through the API, as a client would: the initial administrator
   signs in, adds the stub provider and model, and creates 40 people. Through
   SQL, for volume: **10,000 conversations of 30 messages, 300,000 messages
   (a `message` table of about 330 MB with its indexes)**, seeded in about 20 s.
   The SQL is generated from `information_schema` at run time: known columns
   get meaningful values, and any other `NOT NULL` column without a default
   gets a neutral value for its type, so the seeder keeps working as the
   schema grows. (The accounts are marked email-verified in SQL; the test has
   no mail server.)
4. **Load** (`load.mjs`, Node `fetch`, no dependencies): six virtual users,
   each a different person with their own forwarded client address. Each
   loops: sign in (every 25 rounds), `GET /api/me`, the sidebar
   (`/api/threads?view=sidebar`, `/api/projects/sidebar`), open a seeded
   conversation (`/api/threads/:id`, `/api/chat/:id/messages`), every second
   round start a conversation and send a message, reading the stream to the
   end, and search (`/api/threads/search`). Think time 200-600 ms. Every
   request is recorded with its phase, status, time to headers and total time
   (`events.ndjson`).
5. **Phases, all under that load:**
   - `baseline` (20 s);
   - `migrate`: TO's migrate job;
   - `smoke-old`: the smoke suite against the FROM replicas on the new schema;
   - `replace-api-1`, `replace-api-2`: wait until the stub is streaming a
     reply to that replica, `docker compose stop -t 30` (SIGTERM, then SIGKILL
     after 30 s, like a Kubernetes grace period), start TO, wait for
     `/api/health/ready`, then 15 s for the proxy to re-resolve `api`;
   - `replace-web-1`, `replace-web-2`: take the proxy out of the load's
     rotation (as a load balancer drains a node), stop it, start TO, put it
     back;
   - `smoke-new`: the smoke suite against TO, where every endpoint must exist;
   - `cooldown` (10 s).
6. **Report**: `report.json` and `report.md` in `--out` (default
   `tools/upgrade-test/out/<time>/`), with per-phase and per-request latency,
   failures, replica stop times and exit codes, reply outcomes, the longest
   lock waits seen in `pg_stat_activity` with the query blocking them, and
   container logs. PostgreSQL runs with `log_lock_waits`, so its log quotes
   blocked statements too.

The **smoke suite** (`smoke.mjs`, 52 steps) is what a released web client
does: health, auth status, a refused bad password, sign-in and session; the
person's settings, sessions, usage, onboarding, broadcasts, share links,
memory and model catalogue; create a conversation, send a message and read
the stream to the end, stored messages, nothing left to resume, read, rename
and pin, sidebar, history page, search, Markdown export, archive, trash and
restore, permanent delete; create, read, update and delete a project with a
conversation in it; administration reads (overview, setup status, users and
one user, roles, providers, models, usage overview, spend, limits and
storage, audit log, settings, system health); a person refused
administration; sign-out. Against FROM, an endpoint FROM does not have (the
API's catch-all `Route not found`) is skipped and listed, since an older
client never calls it.

### The verdict

| Check | Default |
| --- | --- |
| The migrate job succeeds | |
| No 5xx, no network errors or timeouts, no unexpected 4xx | Reads may be retried once on a network error or 502/503/504, as the design allows for idempotent requests; retries are counted and listed. A refused connection to a stopped web proxy moves to the other one. Writes are never retried. |
| Time to response headers | p99 < 2 s (`--p99-ms`), max < 5 s (`--max-ms`); a request times out at 30 s |
| No application query waits on a lock longer than | 3 s (`--lock-wait-ms`), sampled every second; the migration's own session is excluded |
| The FROM smoke suite passes on the new schema; the TO smoke suite passes | |
| No reply ends in an `error` event | |
| Replies cut off by a stopping replica | **Reported, allowed** (`--allow-cut-replies`, on until design item 13 ships) |
| Requests while an API replica is stopping | From SIGTERM until 15 s after it exits (`--gap-tail-ms`), failures and latency are **reported, not failed** (`--allow-shutdown-gaps`, on until item 13 ships). Outside those windows, every check above applies in full. |
| Load ran in every phase; a reply was in flight at each API stop | |

A cut reply is one whose stream ended without `finish`. The load then does
what the web app does, `GET /api/chat/:id/stream`, and records whether the
reply resumed, and the stored status afterwards.

Exit code 0 is a pass, 1 a failed verdict, 2 a test that could not run.
`--expect-fail` inverts 0 and 1, for negative controls.

## Running it

Docker with Compose, Node 22, and network access to GHCR (the images are
public; no login).

```bash
node tools/upgrade-test/run.mjs                         # previous release -> this checkout
node tools/upgrade-test/run.mjs --from v0.9.2           # another FROM
node tools/upgrade-test/run.mjs --to-api oci-upgrade-api:to --to-web oci-upgrade-web:to  # reuse a build
node tools/upgrade-test/run.mjs --inject index --expect-fail   # a negative control
node tools/upgrade-test/run.mjs --keep                  # leave the stack up afterwards
node tools/upgrade-test/run.mjs --help
```

A run takes about 5-6 minutes after the images exist: a minute to start and
seed, then the fixed phases. It tears its project and volumes down at the
end (`--keep` leaves them; `docker compose -p oci-upgrade -f
tools/upgrade-test/compose.yaml --profile tools down -v` removes them). The
TO images it builds stay tagged `oci-upgrade-api:to` and `oci-upgrade-web:to`
for reuse; injected ones are `oci-upgrade-api:inject-<case>`.

Released images are `linux/amd64` only. On an arm64 machine FROM runs
emulated, which is slower but was well within the bounds on an Apple silicon
laptop; TO is built natively.

The smoke suite also runs on its own against any stack built this way:
`node tools/upgrade-test/smoke.mjs --base http://127.0.0.1:18480`.

### In CI

`.github/workflows/upgrade-test.yml` runs on pull requests that touch
`packages/db/drizzle/**`, `packages/db/src/**`, the tool or the workflow; on
every `v*` tag push (a check alongside publication, not a gate on it); and by
manual dispatch with `from`, `to` (a published tag instead of building) and
`inject` (a negative control; the run must then fail). It builds TO for
`linux/amd64` with Buildx, reusing the CI workflow's container cache and
publishing nothing, with read-only permissions. The report is uploaded as the
`upgrade-test-report` artifact and appended to the job summary. Expected
runtime is 10-15 minutes (image builds 3-8 minutes depending on the cache,
then the run); the job's limit is 30 minutes.

## Negative controls

`--inject <case>` appends one deliberately unsafe migration to TO's bundled
migrations (a new SQL file and journal entry layered onto the TO image;
`inject.mjs`). Each must fail the run. Results on 4 October 2026, FROM
v0.10.2, 300,000 messages, Apple silicon laptop:

| Case | Migration | Result |
| --- | --- | --- |
| `index` | `CREATE INDEX` (GIN, English full text) on `message`, without `CONCURRENTLY` | **Fails.** The build took 12.6 s inside the migration transaction. New messages (`insert into message`) and the final save of replies already streaming (`update message ...`) waited up to 10.9 s on the lock; the slowest request took 10.4 s. |
| `drop-column` | `DROP COLUMN message.web_search_used` | **Fails.** 1,190 of 3,378 requests answered 500; FROM smoke 48/52 (sending, stored messages, opening a conversation, usage overview). |
| `rename-column` | `RENAME COLUMN thread.pinned` | **Fails.** 2,288 of 3,724 requests answered 500; FROM smoke 37/41. |
| `rewrite` | `ADD COLUMN ... NOT NULL DEFAULT clock_timestamp()` on `message` | **Fails.** A table rewrite under `ACCESS EXCLUSIVE`: 11.6 s, reads and writes of `message` waited up to 9.8 s. (`DEFAULT now()` would not rewrite: `now()` is stable, so PostgreSQL 11 and later store it as a fast default. The test uses a volatile default.) |
| `lock` | `LOCK TABLE thread IN ACCESS EXCLUSIVE MODE` held for 15 s | **Fails.** Every request touching `thread` waited, up to 15.1 s. |

Scale matters: at 200,000 shorter messages (a 164 MB table) the `index` build
took 5.7 s and the slowest request 3.1 s, under every bound, so that control
passed. The default dataset was raised to 300,000 longer messages so that
a missing `CONCURRENTLY` on `message` is caught with room to spare. A faster
CI machine shortens the build; if the `index` control ever passes in CI,
raise `--threads` or `--messages-per-thread`.

## Real upgrades

Same machine and dataset, TO = this source (v0.10.2 plus unreleased work, no
new migrations):

| FROM | Migrations applied under load | Outside shutdown windows | While a replica stopped (reported) | Replies | Verdict |
| --- | --- | --- | --- | --- | --- |
| v0.10.2 | none (job 1.6 s) | 1,162 requests, 0 failed, p99 143 ms, max 206 ms, no lock waits | 706 requests, 0 failed, max 5.0 s | 131: 129 complete, 2 cut | **Pass** |
| v0.10.1 (the default FROM; TO built by the runner) | none (job 3.1 s) | 1,162 requests, 0 failed, p99 1.2 s, max 2.5 s (see note), no lock waits | 756 requests, 0 failed, max 6.9 s | 136: 134 complete, 2 cut | **Pass** |
| v0.10.0 | none: v0.10.0 already includes 0038 (job 2.0 s) | 1,129 requests, 0 failed, p99 147 ms, max 860 ms, no lock waits | 706 requests, 1 failed (`POST /api/chat` 502), max 5.0 s | 129: 128 complete, 1 cut | **Pass** |
| v0.9.2 | 0035-0038 in 1.7-2.3 s, no lock waits | 1,151 requests, 0 failed, p99 1.6 s, max 2.9 s (see note) | 823 requests, 0 failed, max 5.0 s; the first run had 2 failed (`POST /api/threads` 502, `POST /api/chat` 502) | 140: 138 complete, 2 cut | **Pass** |

Both smoke suites passed 52/52 on every path. For v0.9.2 the first run's FROM
smoke failed one step, `GET /api/me/share-links`, which v0.9.2 does not have
(added in v0.10); the suite now skips endpoints the running release lacks and
lists them, and the second run (the row above) passed with that one skipped.

These local runs shared the Docker VM with another project's scale test
(its PostgreSQL at about 400 % CPU), which is why search, the heaviest request,
reached 1.5-2.9 s in some phases of some runs regardless of version (the same
phases took 100-200 ms in the other runs). The bounds held, but with less room
than on a quiet machine; CI runners are dedicated.

## Known gaps found

These are product behaviour, reported by the test rather than fixed by it.

1. **A stopping API replica is SIGKILLed with work in flight** (design item
   13). On SIGTERM the API closes its HTTP server, which waits for every open
   connection. The web proxy's keep-alive connections stay open and keep
   carrying new requests, because nothing marks the replica not-ready and it
   stays in DNS until it exits. So a replica serving a reply when it is
   stopped keeps accepting work for the whole grace period and is killed at
   the end of it: exit code 137 after 30 s in most runs (once it drained in
   25 s and exited 0; a replica with no open streams exits in 0.2 s). Whatever
   is in flight at the kill fails: 1-3 replies cut per run, and occasional
   `502` answers to `POST /api/chat` and `POST /api/threads` (which neither
   the proxy nor the client may retry).
2. **A cut reply does not recover.** `GET /api/chat/:id/stream` answers 200,
   replays the saved part, then waits for a producer that no longer exists
   and ends about 30 s later without `finish`. The message stays
   `status = 'streaming'` in the database at the end of the test.
3. **Requests stall for up to 5-7 s after a replica dies.** For 10-15 s after
   the old replica exits, p99 time to headers was 2-4.5 s and the maximum
   5.0-6.9 s: Caddy keeps the dead address until its next DNS refresh (`dynamic a
   ... refresh 10s`) and retries it for `lb_try_duration 5s`. Passive health
   checking (`fail_duration`), a shorter dial timeout, or the replica going
   not-ready before it stops (item 13) would remove most of it.
4. **Migrations block the application for as long as a step holds a lock.**
   Everything runs in one transaction with no `lock_timeout` or
   `statement_timeout` (the negative controls above show the effect). The
   migrations from v0.9.2 to now are all fast, so the real upgrades see no
   lock waits. A `lock_timeout` is being added to the migrator separately; it
   bounds how long a step *waits* for a lock, not how long it *holds* one, so
   the `index`, `rewrite` and `lock` controls should still fail (the stall,
   or the migration job failing on a statement timeout).
5. **Sign-in from one address is throttled per process.** Better Auth's own
   limiter ("Too many requests. Please try again later.", per process, in
   production) refused the load's sign-ins after a few per 10 seconds while
   every virtual user came from one address, regardless of
   `RATE_LIMIT_AUTH_PER_MINUTE`. The test now gives each person their own
   forwarded address. Relevant to sign-in storms from behind one NAT (design
   item 22).
6. **People created by an administrator need email verification by
   default**, so an instance without SMTP cannot sign them in until an
   administrator turns verification off. The test marks them verified in SQL.

Replacing the **web proxies** caused no failures once each was drained first;
Caddy exits on SIGTERM after its open streams finish (0.2-7 s).

## What the test proves, and what it does not

It proves, for the paths it runs: the new release's pre-deploy migrations
apply under steady load without server errors or lock stalls at this scale;
the previous release keeps answering the requests its client makes on the new
schema; replicas can be replaced one at a time behind the bundled proxy; and
the new release serves the same requests afterwards. The negative controls
show it catches a missing `CONCURRENTLY`, a table rewrite, a long lock and a
dropped or renamed column.

It does not prove:

- behaviour at production scale: 300,000 messages, not tens of millions; a
  step that takes 100 ms here can take minutes there (design section 10's
  harness and section 4's linter cover that);
- every endpoint: the load and the smoke suite cover the common paths, not
  attachments, imports, exports beyond Markdown, connectors, SSO or sharing;
- the web application itself: requests are made the way the web app makes
  them, but no browser runs;
- post-deploy steps and background migrations (design section 1): not built
  yet, so the test has no phase for them;
- database failover (design section 3), Redis failover, or several web
  proxies behind a real load balancer;
- upgrades that skip a minor.
