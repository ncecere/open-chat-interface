# Database failover

How OCI rides out a change of PostgreSQL primary (v0.11 design, section 3),
how that is tested on every pull request and weekly against a real Patroni
cluster, and what the tests found. Operators: see
[OPERATIONS.md, "Database failover"](../OPERATIONS.md#database-failover).

## What a failover does to OCI

On Patroni, a managed service or anything behind a virtual IP or HAProxy, the
old primary's connections all drop at once. Open transactions roll back,
session advisory locks are released, and every query in flight fails with a
connection error: `57P01` (admin shutdown) or, from postgres.js,
`CONNECTION_CLOSED`. For a few seconds new connections fail too
(`ECONNREFUSED`, `ECONNRESET`, `57P03`), or reach a node that is no longer
primary (`25006`, read-only transaction) until the proxy notices.

## What OCI does about it

| Work | On a lost connection |
| --- | --- |
| **Reads** (`GET`, `HEAD`, `OPTIONS`) | Run once more within the request, after 250 ms, on a new connection (`middleware/read-retry.ts`). A second failure is answered as below. |
| **Writes** (every other method) | Never repeated automatically: they may have committed just as the connection dropped. Answered **`500`** with `"retryable": true` in the error and `X-OCI-Retryable: database-connection` (plus `Retry-After: 1`), so a client that knows the operation is safe can send it again. **Not `503`**: that status means "this replica is draining" (`lib/drain.ts`), and the bundled proxy takes a replica that answers `503` out of rotation. |
| **Starting a reply** (`persistTurn`, the prompt's transaction) | Retried for up to 10 s. A transaction whose commit was lost with its connection is recognised on the retry by the reply's lineage, which only that transaction sets, so the message is stored once. |
| **A reply's final save** | The reply streams through Redis, so it is not interrupted. Its save, the thread touch and the usage settlement are each retried for up to 30 s with backoff (`services/chat/run-save.ts`); a continued reply's added totals are reapplied only while it is still `streaming`, so they are never counted twice. The run keeps heartbeating in Redis meanwhile, so no replica recovers it as interrupted. If the database is still away after that, the claim is recovered as interrupted from the captured stream once it is back (item 13). |
| **Background jobs** | The job's advisory lock lives on its own connection, so a failover releases it. The lock connection is checked every 5 s and at each check a job makes between batches (`jobMayContinue()`); once the lock is lost the job stops after the batch in hand, its run is recorded as cut short ("Stopped early: the job lost its lock…") and nothing is unlocked. The next tick takes the lock again on the new primary. The job's run record is saved through the failover (bounded retry), so no run is left `running`. |
| **Imports** | A lost connection, a lost lock or a shutdown at a checkpoint (every 25 conversations) puts the import back in the queue without using one of its attempts; the next run reads the file again and skips the conversations already stored. |
| **Pre-deploy migrations** | One transaction: a failover rolls the attempt back, advisory lock included, and the rerun (the orchestrator restarting the migrate job) starts cleanly. |
| **Work requested of a worker** | `LISTEN` reconnects with postgres.js and listens again; a request sent while it was away is picked up by the job's next tick. |
| **Readiness** | `/api/health/ready` stays `200` (`"status": "degraded"`) for the first 30 s the database is unreachable, then `503`. Failing at once would take every replica out of rotation together during a failover. |

A failure counts as a lost connection when its error, or the error's `cause`
(Drizzle wraps driver errors), has one of the codes in
`lib/db-connection.ts`, or when a request fails unexpectedly (including a
library's own `500`, such as Better Auth's) while the application pool lost a
connection.

## The driver

postgres.js reconnects on its own: a dropped connection is discarded and the
next query opens a new one. Version 3.4.9 mishandled a connection closed by the
server while a transaction or reservation was using it, in four ways: an
uncaught `TypeError` that ends the process (porsager/postgres#1154), a closed
connection moved into a queue nothing empties, stale state carried into the
reconnected session, and a dead reserved connection returned to the pool. The
pinned patch fixes all four; [patches/README.md](../../patches/README.md)
has the code paths. `createDatabase` also lowers `connect_timeout` from 30 s
to 10 s.

A connection the network silently drops (no `RST`) is noticed only by TCP
keepalive, which takes minutes. Put HAProxy (with `on-marked-down
shutdown-sessions`), a pooler or a virtual IP that resets connections in front
of the cluster, as the drill does.

## Tests

### Every pull request (real PostgreSQL)

Each test terminates every backend of its own throwaway database with
`pg_terminate_backend` from a separate session, in the middle of the work:

| Test | Scenario | Before | After |
| --- | --- | --- | --- |
| `failover-migration.live.test.ts` | A migration half applied (driven through the real migrator) | Passed already: rolled back, rerun clean | Kept as a regression test |
| `failover-jobs.live.test.ts` | A job between batches, holding its lock | **Failed**: it ran batches 2 and 3 after losing the lock, while a second replica that had taken the lock ran its own | Stops at the next check; recorded as cut short; next tick re-acquires |
| `failover-reply.live.test.ts` | A reply's final save, and storing a new message | **Failed**: the final save failed and the reply stayed `streaming` with no text; the new message got `500` and was not stored | Both retried; reply `complete`, message stored once |
| `failover-requests.live.test.ts` | A read, a write, a transaction | **Failed**: the read answered `500`; the write's `500` was not marked retryable | Read `200`; write `500` + `X-OCI-Retryable`; transaction rejects promptly, pool reconnects |
| `postgres-transaction-failover.live.test.ts` | `sql.begin` and Drizzle transactions (mid-statement, between statements), a reserved connection; more rounds than the pool has connections | **Failed**: uncaught `TypeError`s, then a pool that never answered again (also with pristine postgres.js 3.4.9) | Rejects with a connection error; nothing uncaught; pool serves the next queries |
| `worker-role.live.test.ts` | The worker's `LISTEN` connection | (new) | Hears requests again after the failover |
| `portability-import.live.test.ts` | An import meeting `57P01`, and a worker stopping mid-import | **Failed**: the import was marked failed, or the rest counted as failed conversations | Requeued, resumed, every conversation imported once |

### Weekly: the Patroni drill

`tools/failover-drill` (workflow `failover-drill.yml`, weekly and on demand)
runs a three-node Patroni cluster (Spilo images, etcd, HAProxy routing on
Patroni's `/primary`), OCI built from the ref (two `OCI_ROLE=web` replicas, one
worker), a light load (six people signing in, browsing, sending messages to a
stub model that streams for three seconds, searching) and a 5,000-conversation
import on the worker. Mid-load, mid-import and with replies streaming it runs
`patronictl failover`, then checks:

- no request failed except with the retryable class within 30 s of a failover;
- every reply finished or was saved as interrupted, and none is left
  streaming or failed;
- the import finished with every conversation and none failed;
- jobs ran successfully after the failover and none was left running.

Results on an M4 Pro (Docker Desktop, 12 CPUs, 7.7 GB):

| Run | Failover | Requests | Replies | Import | Jobs |
| --- | --- | --- | --- | --- | --- |
| 1 failover | `patronictl` 2.4 s; HAProxy on the new primary after 3.1 s | 588, 0 failed; p95 24 ms around the failover (baseline 33 ms), max 2.0 s | 90, all complete | 5,000: 4,319 imported + 681 already stored (skipped on resume), 0 failed | 6 runs after; 1 cut short by the lost lock; 0 left running |
| 2 failovers, a minute apart | 2.6 s / 3.2 s and 2.5 s / 3.0 s | 1,173, 0 failed; max 2.2 s | 180, all complete | 8,000: 7,465 + 535, 0 failed | 13 runs after; 1 cut short; 0 left running |
| Slow failover (earlier build) | `patronictl` 10.9 s; HAProxy after 12.8 s | 635, 8 failed, all retryable `500`s 9–9.5 s in (four reads whose one retry also found no primary, four conversation creations) | 94, all complete | Not finished: the requeue was lost in the outage (fixed: it is now retried) | 27 runs after |

The slow run is why the drill accepts retryable failures inside a window:
when the cluster has no primary for longer than a request's one retry, the
request fails, marked retryable.

What the drill found and this release fixed: an import interrupted by a
failover was marked failed (or its remaining conversations counted as failed);
its requeue, if attempted during the outage, was lost for ten minutes; a job's
run record could be left `running`; and HAProxy's default initial state let
the first connections reach a replica (the drill's HAProxy uses `init-state
down`, as a production one should).

Run it locally: `node tools/failover-drill/run.mjs` (about 5 minutes, about
3 GB of memory); see [tools/failover-drill/README.md](../../tools/failover-drill/README.md).
