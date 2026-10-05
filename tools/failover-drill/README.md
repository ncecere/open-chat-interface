# Failover drill

Moves the primary of a real three-node Patroni cluster while OCI serves a
light load and a worker is in the middle of a job, and fails unless OCI rides
it out: no request fails except with the retryable class (`500` with
`X-OCI-Retryable: database-connection`) within `--window-seconds` of the
failover, every reply in flight finishes or is saved as interrupted, the
import in progress finishes with every conversation, and background jobs run
again. What it proves, the results so far and how failover is handled:
[docs/dev/failover.md](../../docs/dev/failover.md).

```bash
node tools/failover-drill/run.mjs                    # builds images from this checkout
node tools/failover-drill/run.mjs --failovers 2      # two failovers a minute apart
node tools/failover-drill/run.mjs --redis            # kill the Redis primary under Sentinel instead
node tools/failover-drill/run.mjs --api-image oci-failover-api:drill --web-image oci-failover-web:drill
node tools/failover-drill/run.mjs --help
```

Needs Docker with about 3 GB of memory free and Node 22. It runs as the
Compose project `oci-failover` on `127.0.0.1:18580` and removes it afterwards
(`--keep` leaves it running). The report is written to `--out`
(`report.json`, `report.md`, the load's `events.ndjson`). Exit codes: 0 pass,
1 a check failed, 2 the drill could not run. The scheduled workflow is
`.github/workflows/failover-drill.yml` (weekly and on demand).

`--redis` (v0.11 design, item 16) runs Redis under Sentinel (Compose profile
`redis-ha`: `redis-primary`, `redis-replica`, `sentinel-1` to `-3`, quorum 2,
`down-after-milliseconds 2000`), points the API at the sentinels
(`REDIS_SENTINELS`), and instead of moving the PostgreSQL primary kills the
Redis primary with `SIGKILL` while replies stream, every third reply is read
only partly and then resumed (`--cut-every`, `--cut-after-ms`), and every
request passes the rate limits. After the sentinels promote the replica and
System health shows Redis again, the killed node is started and rejoins as a
replica (so `--failovers 2` fails back). It fails unless no request failed,
every reply finished or was resumed to its end and is stored complete, replies
started afterwards are resumable again, and no OCI process exited.

| File | Does |
| --- | --- |
| `run.mjs` | The runner: images, cluster, setup, load, failovers, checks, report |
| `compose.yaml` | etcd, three Spilo (Patroni + PostgreSQL 17) nodes, HAProxy, Redis (one server, or under Sentinel with `--redis`), the stub model, two API replicas (`OCI_ROLE=web`), a worker, the web proxy; images pinned by digest |
| `haproxy.cfg` | Routes to the node Patroni reports as primary; closes connections to a node that stops being primary |
| `load.mjs` | The steady load (child process), one event per request, recording `X-OCI-Retryable` |

It reuses the rolling-upgrade test's stub model, people setup and stream
reader (`tools/upgrade-test/stub-model.mjs`, `seed.mjs`, `lib.mjs`).

Licences of the images: Spilo Apache-2.0 (Patroni MIT, PostgreSQL licence),
etcd Apache-2.0, HAProxy GPL-2.0-or-later (a separate test container, never
distributed with OCI), Redis 7.2 BSD-3-Clause, Node.js MIT.
