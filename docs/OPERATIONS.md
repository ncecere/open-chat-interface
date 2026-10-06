# Production operations

This guide supplements the deployment overview in [README.md](../README.md).
Test backup and recovery procedures against your own storage and identity
provider configuration before relying on them in production.

## Deploy a released version

Select a release tag. The images on GHCR are public, so pulling them needs no
registry login. If you mirror them into a private registry, keep its
credentials in your secret manager; never commit them or put them in
`.env.example`.

```bash
export OCI_VERSION=v0.11.0
export OCI_REGISTRY=ghcr.io/ncecere/open-chat-interface
export OCI_API_IMAGE="$OCI_REGISTRY/api:$OCI_VERSION"
export OCI_WEB_IMAGE="$OCI_REGISTRY/web:$OCI_VERSION"
```

From v0.11, published images are multi-platform: each tag is one index with a
`linux/amd64` and a `linux/arm64` image, built natively and verified alike, so
`docker pull` and Kubernetes pick the node's architecture. Releases before
v0.11 are `linux/amd64` only. Confirm **Publish containers** succeeded for your
version before pulling. Historical `v0.4.1` publication uses the manual dispatch described
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

Versions before 0.5 were not published to GHCR; choose a version whose images
are there.

## Kubernetes with Helm

From v0.11 the repository has a Helm chart,
[`deploy/helm/open-chat-interface`](../deploy/helm/open-chat-interface/README.md),
released with the application (chart `0.11.0` deploys images `v0.11.0`). It
runs the API (`OCI_ROLE=web`), a worker Deployment (`OCI_ROLE=worker`), the web
proxy, and the migration jobs as Helm hooks. PostgreSQL, Redis and S3 are
external: an operator (CloudNativePG, Crunchy, Patroni; a Redis operator with
Sentinel) or managed services. The chart README lists every value.

### Installing with Helm

1. Create the runtime Secret from your secret manager (External Secrets, Sealed
   Secrets, Vault) with at least `DATABASE_URL`, `AUTH_SECRET`,
   `ENCRYPTION_KEY` and `REDIS_URL`; every key becomes an environment variable,
   so `METRICS_TOKEN`, `INITIAL_ADMIN_EMAIL`, SMTP and the v0.11
   `CONTROL_DATABASE_URL`, `READ_DATABASE_URL` and Redis Sentinel or Cluster
   settings go there too. Never put secrets in values.
2. Install the chart published with the release (from v0.11, an OCI
   artifact on GHCR whose version is the release without the `v`; from a
   checkout, use `deploy/helm/open-chat-interface` instead):

   ```bash
   helm install oci oci://ghcr.io/ncecere/charts/open-chat-interface \
     --version X.Y.Z -n oci \
     --set secrets.existingSecret=oci-runtime \
     --set config.appUrl=https://chat.example.com \
     --set web.trustedProxies='10.244.0.0/16' \
     --set ingress.enabled=true --set ingress.className=nginx \
     --set 'ingress.hosts[0].host=chat.example.com'
   ```

3. Configure S3-compatible attachment storage under **Admin → Data & storage
   → Storage** before people upload files: several API and worker pods share
   attachments, and without S3 or `storage.persistence` (a `ReadWriteMany`
   claim) local files are in an emptyDir and lost with the pod.

For production values: at least two API and two web replicas (the defaults),
one or two workers, `web.trustedProxies` set to your ingress controller's pod
range (see [Behind another proxy or an ingress](#behind-another-proxy-or-an-ingress)),
streaming-friendly ingress settings (response buffering off, read timeout of
an hour), `metrics.serviceMonitor.enabled` with `METRICS_TOKEN` and
`metrics.prometheusRule.enabled` for the [service objectives and
alerts](#service-objectives-and-alerts), and an image digest pin. `DATABASE_URL` must be direct or a session-mode pooler, as
above.

### Upgrading with Helm

```bash
# Preflight, changing nothing (Upgrade, step 4)
kubectl -n oci run oci-upgrade-check --rm -i --restart=Never \
  --image=ghcr.io/ncecere/open-chat-interface/api:vX.Y.Z \
  --overrides='{"spec":{"containers":[{"name":"oci-upgrade-check","image":"ghcr.io/ncecere/open-chat-interface/api:vX.Y.Z","command":["node","dist/scripts/upgrade-check.js"],"envFrom":[{"secretRef":{"name":"oci-runtime"}}]}]}}'
helm upgrade oci oci://ghcr.io/ncecere/charts/open-chat-interface --version X.Y.Z \
  -n oci --reuse-values --timeout 30m
```

`helm upgrade` is the three-phase upgrade below:

1. **Pre-upgrade hook** `node dist/migrate.js`: the pre-deploy migrations,
   with the previous release still serving. If it fails, nothing is replaced.
2. **Rolling update** of the API, worker and web Deployments, one pod at a
   time (`maxUnavailable: 0`), every API pod draining as it stops. Pods run
   with `RUN_MIGRATIONS=false` and `RUN_POST_MIGRATIONS=false`.
3. **Post-upgrade hook** `node dist/migrate.js --post`. Its init container
   first waits until the API and worker rollouts have finished and no pod of
   the previous release is still terminating (it reads the Deployments and
   lists Pods with a token and Role that exist only for the hook), so
   post-deploy steps never run beside the previous release, even without
   `--wait`.

Helm waits for hooks at most `--timeout` (default 5 minutes); give it the
preflight's estimate for index builds. The hook Jobs are kept until the next
upgrade (`kubectl -n oci logs job/<release>-open-chat-interface-migrate-post
--all-containers`). A failed post-upgrade hook leaves the new release running
without its new indexes; fix the cause and run `helm upgrade` again, which
resumes. Background migrations then run on the worker.

### Draining and probes in the chart

The chart applies [Shutting down and draining → Kubernetes](#kubernetes):
a 5-second `preStop` sleep, readiness on `/api/health/ready` every 2 s with one
failure, liveness on `/api/health/live`, a startup probe, and
`terminationGracePeriodSeconds: 40` against `SHUTDOWN_DRAIN_TIMEOUT_MS` of
25 s (the chart refuses a grace period that does not exceed drain plus
`preStop`). PodDisruptionBudgets let a node drain stop one pod of each kind at
a time. The web pods find API pods through a headless Service, which lists
only ready pods, and Caddy balances across them itself, so its passive checks
take a single draining pod out of rotation. Workers get the same grace period
and no `preStop` (nothing routes to them).

### Chart security

All pods run as non-root with read-only root filesystems, the `RuntimeDefault`
seccomp profile and no privilege escalation, and pass the Pod Security
`restricted` profile; only `/tmp`, the attachment directory and Caddy's
`/data` and `/config` are writable (emptyDir or the storage volume). Every
container drops all capabilities and adds none: Caddy listens on 8080, and
from v0.11 the web image no longer gives its binary the
`cap_net_bind_service` file capability, which made `exec` fail with every
capability dropped (earlier charts kept `NET_BIND_SERVICE` in the web
container's bounding set for it). To run a web image older than v0.11 with
this chart, set `containerSecurityContext.web.capabilities.add:
[NET_BIND_SERVICE]`. No pod mounts a service account token. A NetworkPolicy (on by default) lets only the
web pods and metrics scrapers reach the API, which is what keeps the client
address trustworthy; egress rules are optional (`networkPolicy.egress`).

### Testing the chart

`.github/workflows/helm.yml` lints and renders the chart with Helm 3 and 4,
validates the manifests with kubeconform, and on linux/amd64 and linux/arm64
runs `deploy/helm/dev/kind-test.sh` on kind: install with single-pod test
PostgreSQL and Redis in a namespace enforcing `restricted`, readiness through
the web Service, `helm test`, the network policy, then `helm upgrade` to a new
tag under load with no failed request.

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
no trustworthy address to record. The Helm chart routes everything to the web
Service and, with its default NetworkPolicy, lets only the web pods connect to
the API.

## Sign-in limits

OCI limits how fast credentials and tokens can be tried (v0.11). Its limits
are the only ones: Better Auth's built-in limiter, which allowed three
sign-ins per address every ten seconds in each replica's memory, is turned
off, because a campus behind one NAT address met it on the first morning of
term. Counts live in Redis, so every replica shares them (without Redis each
replica counts on its own; see [Redis](#redis)). A refused request gets
`429` with `Retry-After`, and the first refusal per window is recorded in the
audit log as `auth.rate_limited` with the scope that refused it.

| Limit | Default | Counts | Setting |
| --- | --- | --- | --- |
| Per account | 10 a minute | **Failed** sign-ins for one email address, from anywhere; sign-up, password reset and verification requests naming it | `RATE_LIMIT_AUTH_PER_MINUTE`, or **Sign-in attempts per minute** on People → Roles & access |
| Per session | the same | Password and email changes with one session | as above |
| Per address | 300 a minute | **Failed** sign-ins and failed single sign-on callbacks from one client address; every sign-up, password reset and verification request from it | `RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE` |
| Address ceiling | 10 × the address limit (3,000) | Every limited request from one address, successful or not | follows the address limit |
| Per identity provider | 3,000 a minute | Every single sign-on callback for one provider, from all addresses | `RATE_LIMIT_AUTH_SSO_PROVIDER_PER_MINUTE` |

How they apply:

- **A successful sign-in costs nothing** against the account or address
  limits. Attempts are counted when they arrive (so a burst sent at once is
  still bounded) and given back when they succeed. A sign-in still in flight
  holds one unit, so the address limit must stay above the number of
  sign-ins one address has in flight at once.
- **People behind one address** (a campus NAT, a VPN, a corporate proxy)
  share the address limit for their *failures* only, and the ceiling for
  everything. 300 failed attempts a minute is about one typo a minute each
  for 300 people signing in at once. Raise it if more people than that sign
  in at the same moment from one address; the per-account limit still stops
  guessing any one account's password.
- **One person retrying a locked account** does not use up the failed
  attempts of everyone else behind the address: once their account is
  refused, their attempts stop counting against the address (they still
  count against the ceiling).
- **Single sign-on** is limited per identity provider, not per address:
  successful sign-ins through a provider are never limited by address, only
  by the ceiling. A provider whose callbacks fail or flood (misconfigured,
  replayed, or under attack) uses up only its own budget. Size it for the
  busiest sign-in rate you expect from one provider: 3,000 a minute is 50 a
  second, enough for 30,000 people in ten minutes.
- **Locking out an account** is possible for anyone who knows its address:
  ten wrong passwords in a minute refuse that account for the rest of the
  minute, wherever the attempts come from. That is the price of the
  per-account limit; it lifts on its own.
- Counts use fixed one-minute windows, so up to twice a limit can pass across
  a window boundary. They stop runaway automation, not every guess.

**Capacity.** Each password sign-in costs about 60 ms of one CPU (scrypt);
the API runs it on libuv's thread pool, which it sizes to one thread per CPU
between 4 and 16 (override with `UV_THREADPOOL_SIZE`). Measured on one
replica: 60 sign-ins a second with a p95 of 71 ms
([scale harness](dev/scale-harness.md#sign-in-storms-with-shared-addresses-v011-item-22)).
Beyond what a replica's CPUs allow, add replicas: the limits are shared.

The address is the one the web container's proxy decided (above). Behind a
load balancer that is not in `TRUSTED_PROXIES`, every person appears to come
from the load balancer and shares one address limit: fix `TRUSTED_PROXIES`
first, then size the address limit for real NATs.

## Database connections for maintenance

Background jobs, migrations and a worker's `LISTEN` need PostgreSQL sessions of
their own. From v0.11 they use the **control** connection string,
`CONTROL_DATABASE_URL` (default: `DATABASE_URL`), which must reach PostgreSQL
directly or through a **session-mode** pooler; everything else may go through
a transaction-mode pooler ([connection pooling](#connection-pooling)). Each
concurrently attempted job opens one private lock connection per replica in
addition to the application pool (default ten connections). Include that
headroom in database connection limits. See
[background jobs](admin/operations.md#background-jobs) for scheduling and retry
guarantees; jobs are listed, and can be run by hand, on **Admin → Data &
storage → System health**.

## Connection pooling

From v0.11 (design, section 11) OCI keeps two kinds of database connection,
so a deployment with many replicas can put a transaction-mode pooler such as
PgBouncer in front of PostgreSQL:

| Variable | Used for | May point at |
| --- | --- | --- |
| `DATABASE_URL` | The **application pool**: every request and every job's work | PostgreSQL, a session-mode pooler, or a **transaction-mode** pooler |
| `CONTROL_DATABASE_URL` (default: `DATABASE_URL`) | **Control connections**: migrations (`migrate`, `migrate --post`, and at startup), background jobs' advisory locks, a worker's `LISTEN` (and a `web` replica's, while it waits for a worker to take a manual run), `pg_dump` for backups | PostgreSQL directly, or a **session-mode** pooler; never transaction mode |
| `READ_DATABASE_URL` (optional) | Heavy administrative reads ([below](#read-replica)) | A streaming replica, or a pooler in front of one |

Nothing on the application pool keeps session state after a transaction:
prepared statements are off, settings are `SET LOCAL`, advisory locks used
there are transaction locks, and notifications are sent with `pg_notify`
(delivered at commit). What does need a session moved to the control
connections:

| Session state | Where | Before v0.11, behind a transaction-mode pooler |
| --- | --- | --- |
| A job's session advisory lock, held for the whole run | One control connection per running job | A second replica took a job the first was running (the lock was re-entered on the same pooled server connection), the first's lease check landed on another connection and found its lock gone, and the lock stayed behind on a pooled connection |
| A worker's `LISTEN oci_job_requests` | One control connection per worker or `all` replica | No request from a `web` replica was ever heard (work waited for the job's next tick) |
| A `web` replica's `LISTEN oci_job_request_acks` for **Run now**, **Back up now** or **Export now** | One control connection for up to 5 s per run | — |
| `migrate --post`: session lock and `statement_timeout = 4h`, `lock_timeout`, `idle_in_transaction_session_timeout` | One control connection (plus one lock monitor) while it runs | Those settings and the lock stayed on a pooled server connection that ordinary requests then used |
| Pre-deploy migrations (one transaction) | One control connection (plus one lock monitor) | Worked (transaction-scoped), moved for clarity |
| `pg_dump` (session settings, one long transaction) | One control connection while a backup runs | Its `SET`s could land on a different server connection from its transaction |

Pool sizes per replica: `DATABASE_POOL_MAX` (default 10) application
connections; control connections only while used: one per job running at that
moment (a few), one for `LISTEN` on a worker or `all` replica, one for up to
5 s on a `web` replica when an administrator runs a job by hand, one or two
during a migration or backup, and, without Redis, one to show the replica is
running (below). `READ_DATABASE_POOL_MAX` (default 5) connections to the
replica when one is set.

### PgBouncer in transaction mode

```ini
; pgbouncer.ini
[databases]
oci = host=postgres port=5432 dbname=oci

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
; Server connections to PostgreSQL: size for (replicas x DATABASE_POOL_MAX)
; client connections at the concurrency PostgreSQL handles well.
default_pool_size = 40
max_client_conn = 2000
; OCI does not use protocol-level prepared statements; nothing to track.
max_prepared_statements = 0
server_reset_query =
```

```bash
DATABASE_URL=postgres://oci:...@pgbouncer:6432/oci            # transaction mode
CONTROL_DATABASE_URL=postgres://oci:...@postgres:5432/oci     # direct (or a session-mode pool)
```

Point `CONTROL_DATABASE_URL` at PostgreSQL itself, or at a second PgBouncer
database entry with `pool_mode=session` (a few connections per replica is
enough). A live test runs the API's requests, job locks, `LISTEN`, post-deploy
steps and background migrations through PgBouncer 1.25 in transaction mode and
checks that no pooled server connection is left with a lock, a setting or a
`LISTEN` (`apps/api/src/__tests__/live/pgbouncer.live.test.ts`).

### Read replica

`READ_DATABASE_URL` sends heavy administrative reads that tolerate a second of
staleness to a streaming replica: **Admin → Overview** (instance-wide counts and
activity) and **Admin → Usage** (activity, spend, limits and storage reports;
their rollups already trail by up to 30 s). Nothing a person reads about their
own data uses it, nor anything that writes.

OCI uses the replica only while it is within `READ_DATABASE_MAX_LAG_MS`
(default 1000): while those pages are in use it samples the primary's WAL
position every 250 ms and checks that the replica has replayed what the
primary had written that long ago. When the replica is behind, unreachable or
not yet checked, the reads go to the primary; a read that fails on the replica
(a lost connection, a query cancelled by recovery) is run again on the
primary. The gauge `oci_read_replica_in_use` shows which. Point it at one
replica, or a pooler in front of one: with a load balancer over several, each
check reaches one of them.

## Redis

Redis carries reply streams (so a reply can be resumed after a disconnect, or
on another replica), the per-person concurrency caps, rate limits and the
replicas' heartbeats. One replica works without it; **more than one requires
it** (v0.11): without it each replica keeps its own counters, so every limit
is multiplied by the replica count, and a reply can only be resumed on the
replica writing it. Each replica logs a warning, and System health shows an
error, when several replicas share the database without Redis (counted from
the database's connections, which OCI names `oci:<role>:<id>@<host>`).

Configure one of:

| Variables | Redis |
| --- | --- |
| `REDIS_URL=redis://[user:password@]host:6379[/db]` (`rediss://` for TLS) | One server |
| `REDIS_SENTINELS=s1:26379,s2:26379,s3:26379`, `REDIS_SENTINEL_NAME` (default `mymaster`) | Sentinel: OCI asks the sentinels for the primary and follows a failover |
| `REDIS_CLUSTER_NODES=c1:6379,c2:6379,c3:6379` | Redis Cluster (primaries serve every command) |

With Sentinel or Cluster, `REDIS_USERNAME`, `REDIS_PASSWORD` and `REDIS_TLS=true`
apply to the data nodes; `REDIS_SENTINEL_USERNAME`, `REDIS_SENTINEL_PASSWORD`
and `REDIS_SENTINEL_TLS=true` to the sentinels; `REDIS_TLS_CA_FILE` names a PEM
file of certificate authorities. If more than one is set, Cluster wins over
Sentinel over `REDIS_URL`. `REDIS_COMMAND_TIMEOUT_MS` (default 2000) bounds any
single command.

On Redis Cluster every multi-key operation stays in one hash slot: a reply's
keys share its run's hash tag (`oci:chat-stream:run:{<run>}:…`), the
thread's pointer has its own (`oci:chat-stream:thread:{<thread>}:active`), and
the replica heartbeats share `{replicas}`. Key names on one server and under
Sentinel are unchanged from earlier releases, so a rolling upgrade keeps every
reply in flight. Moving an instance from one server to Cluster is a new Redis:
replies streaming at that moment cannot be resumed (they are still saved), and
counters start again.

### When Redis is unavailable

No request waits on Redis for longer than `REDIS_COMMAND_TIMEOUT_MS`: commands
are refused at once while the connection is down, and the client reconnects in
the background (asking the sentinels for the new primary, or refreshing the
cluster's slots). Until it is back:

| Feature | Without Redis |
| --- | --- |
| Replies | Keep streaming to the person and are saved as usual. A reply in progress keeps the frames Redis could not take (up to 30 s) and stores them once it is back, so following and resuming it continue; past that, its live replay is given up and the saved message is shown. New replies are not resumable until Redis is back. A request to resume waits up to 5 s for a reconnecting Redis. |
| Concurrency caps | Counted per replica (each replica allows the configured number) |
| Rate limits | Counted per replica, so each limit is multiplied by the replica count |
| Replica heartbeats | Not written: System health lists no replicas, and the Background workers check falls back to recent job runs |
| Worker requests | Unaffected (they use PostgreSQL `NOTIFY`) |
| Settings and other cached configuration | A change applies at once on the replica that made it; the others see it when their copy expires (30 s for settings, 15 s for webhook endpoints, 10 s for the connector catalogue) instead of at once. See [below](#settings-changes-and-other-replicas). |

A failover is followed within moments of the sentinels promoting a replica.
In the drill (`node tools/failover-drill/run.mjs --redis`) and the live test
(`redis-sentinel-failover.live.test.ts`) the Redis primary is killed mid-reply
and mid-rate-limit; replies finish or resume with every frame, no request
fails and no process exits ([docs/dev/failover.md](dev/failover.md#redis)).

### Settings changes and other replicas

Each replica keeps what it reads on nearly every request in memory: instance
settings (features, roles and their features and tools, authentication policy,
branding, rate limits, provider capacity limits, read-only mode, retention,
storage, search and the rest), the connector catalogue and the webhook
endpoints. The model catalogue and SSO providers are read from the database on
each use and need nothing.

From v0.11 a change made on one replica is published on Redis
(`PUBLISH oci:cache-invalidate:<organization id>`), and every replica clears
its copy at once: turning a feature off, changing a role or switching
[read-only mode](admin/maintenance.md) applies everywhere within
milliseconds. Each replica (and worker) holds one more Redis connection for
this, in subscriber mode, made the same way as the others (one server,
Sentinel or Cluster; with Cluster, classic pub/sub reaches every node).

Without Redis, or while a replica's subscription is away, the copies expire
as before (30 s for settings), so a change still reaches every replica, just
not at once; a replica that subscribes again after being away clears
everything it had cached, since what was published meanwhile is lost.
**System health → Health checks → Cache invalidation** warns when the replica
answering is not subscribed, and the `oci_cache_invalidation_listening` metric
is 0 on such a replica.

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

## Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` encrypts the secrets OCI stores: model provider API keys,
connector shared credentials, OAuth client secrets and people's connector
tokens, webhook signing secrets, and the credentials in instance settings
(object storage, backup and compliance export destinations, web search
providers, the SMTP password). From v0.11 it can be replaced without
downtime and without re-entering any of them. Single sign-on client secrets
are kept by Better Auth in `sso_provider` and are not encrypted with this key.

Each value stored by v0.11 names the key that encrypted it
(`oci:v1:<key id>:...`, where the key id is 12 hexadecimal characters derived
from the key, not the key). Values written before v0.11 name none; they are
tried with every configured key.

**Before you start**: the upgrade to v0.11 must be complete, `migrate --post`
included (System health, **Encryption keys**, no longer says re-encryption
waits for it). Never rotate during an upgrade: v0.10 replicas know only one
key.

1. **Generate a new key** and keep the current one: both go in your secret
   manager. `openssl rand -hex 32`.
2. **Configure both on every replica, API and worker alike**:
   `ENCRYPTION_KEY=<new>` and `ENCRYPTION_KEYS_PREVIOUS=<old>` (several
   previous keys are separated by commas). Roll the replicas as for any
   configuration change. A replica with the new key encrypts with it and
   decrypts old values with the previous one; a replica still on the old
   configuration cannot read values the new key wrote, so finish the rollout
   promptly, and do not change secrets in the admin pages until it is done.
3. **Wait for re-encryption.** Within a minute the `encryption.rotation` job
   (on worker or `all` replicas) schedules one background migration per
   table, `0.11.reencrypt-*`, which rewrites every value under the new key in
   batches. Follow it on **System health → Background work**; pause, resume
   or resize batches there as for any background migration.
4. **Check** System health, **Encryption keys**: it says *Previous keys still
   in use: N values*. When N is 0 it says so and that
   `ENCRYPTION_KEYS_PREVIOUS` can be removed.
5. **Retire the old key**: remove `ENCRYPTION_KEYS_PREVIOUS` and roll the
   replicas again. Keep the old key in your secret manager until a backup
   taken after this step exists: older database backups still need it (add it
   back to `ENCRYPTION_KEYS_PREVIOUS` after restoring one).

If a re-encryption migration fails, System health shows which table, column
and row could not be decrypted (never the value) and the key id it names.
Usually that value was written with a key that is not configured: add that
key to `ENCRYPTION_KEYS_PREVIOUS`, or re-enter the credential in the admin
pages, then resume the migration on Background work. The **Encryption keys**
check is an error while any value needs a key that is not configured.

Never:

- rotate the key as part of a rollback, or during an upgrade;
- replace `ENCRYPTION_KEY` without putting the old value in
  `ENCRYPTION_KEYS_PREVIOUS`: every stored secret becomes unreadable;
- remove a previous key while System health still counts values under it;
- reuse a key as both current and previous (it is ignored as previous), or
  use a key shorter than 32 characters (refused at start-up).

| Variable | Default | Meaning |
| --- | --- | --- |
| `ENCRYPTION_KEY` | required | The key new values are encrypted with. |
| `ENCRYPTION_KEYS_PREVIOUS` | unset | Earlier keys, comma-separated, used only to decrypt values not yet re-encrypted. |

## Upgrade

From v0.11 an upgrade changes the database in three phases
([database development](dev/database.md#three-kinds-of-migration)):
**pre-deploy** migrations before replicas are replaced (fast, transactional),
**post-deploy** steps after every replica runs the new release (concurrent
index builds, validations, drops), and **background** migrations that the API
replicas work through afterwards while OCI serves.

1. Read every changelog entry between the deployed and target versions.
2. Back up PostgreSQL, attachment objects, and deployment secrets.
3. Pull the target versioned API and web images.
4. **Check.** Run the target image's preflight against the production
   database. It changes nothing:

   ```bash
   # Compose: OCI_API_IMAGE set to the target image
   docker compose --profile tools run --rm migrate node dist/scripts/upgrade-check.js
   # Any container runtime
   docker run --rm -e DATABASE_URL=postgres://... ghcr.io/ncecere/open-chat-interface/api:vX.Y.Z \
     node dist/scripts/upgrade-check.js            # --json for the report as JSON
   ```

   It lists the release and schema, the pending pre-deploy migrations with
   the rows and size of every table each statement touches, the post-deploy
   steps with the indexes they build and roughly how much disk each needs
   (OCI cannot read free disk space through SQL; keep twice the estimate
   free), background migrations, any unfinished work an earlier release left
   that this one requires, and a verdict. Exit code 0: a rolling upgrade (or
   nothing to do); 2: needs a maintenance window (a pre-deploy statement
   grows with a large table, or the database is more than one minor behind);
   3: cannot run yet (required work unfinished, or the database was migrated
   by a newer release); 1: the check failed. **Admin → System health →
   Upgrades** shows the same report for the running release.
5. **Pre-deploy.** For a multi-replica deployment, run migrations once before
   replacing API replicas:

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
   or evidence that reverting an image after newer migrations is safe. If the
   database cannot be reached (the connection is refused, or its host name does
   not resolve), startup waits up to 30 s for it, logging "The database is
   unreachable; waiting for it before checking its migrations" with the
   driver's reason, then exits with "Could not reach the database to check its
   migrations (reason)", not a migration error. A worker logs "Failed to start
   the worker", the API "Failed to start API".
   `migrate` refuses, changing nothing, if the release requires an earlier
   release's background migration or post-deploy step that has not finished;
   the message names it. Finish it on the release you are running (step 7),
   then upgrade.
6. **Replace** API replicas one at a time. From v0.11 each one drains when it
   is stopped (see [Shutting down and draining](#shutting-down-and-draining));
   a replica on an older release still cuts the replies it is writing, which
   v0.11 replicas then save as interrupted. Wait for `/api/health/ready`,
   then verify authentication, chat, search, and attachment access.
7. **Post-deploy**, once every replica runs the new release:

   ```bash
   docker compose --profile tools run --rm migrate-post
   # or, with any runtime: node dist/migrate.js --post
   ```

   It refuses to run until every pre-deploy migration of the release is
   applied. Each step runs outside a transaction, with the migration lock
   timeout and `POST_MIGRATION_STATEMENT_TIMEOUT_MS`; an index is built
   `CONCURRENTLY`, so reads and writes continue. It is safe to run again at
   any time: finished steps are skipped, an interrupted one (a killed job, a
   failover) is repeated, and an index an interrupted build left `INVALID` is
   dropped and rebuilt. Then it schedules the release's background migrations.
   Until it has run, the release works, without the new indexes' speed-up.
8. **Background migrations** run on the API replicas on their own and show on
   **System health → Background work** with their progress. Nothing needs to
   wait for them, except the next upgrade if its release requires them (the
   preflight says so).

A single instance with `RUN_MIGRATIONS=true` does steps 5 and 7 itself: it
migrates at startup and, once serving, applies its post-deploy steps from a
background job (`RUN_POST_MIGRATIONS` defaults to `RUN_MIGRATIONS`). With
several replicas keep `RUN_POST_MIGRATIONS=false` (the default when
`RUN_MIGRATIONS=false`) and run step 7 yourself: nothing in the database tells
OCI that every replica runs the new release, and a post-deploy step may drop
something the previous release still reads.

### Upgrades that need a window

When the preflight answers "needs a window" (exit code 2), or the change is
outside OCI (a database move, a major PostgreSQL upgrade, a restore), put the
instance in [read-only mode](admin/maintenance.md) instead of taking it down:
people keep reading, searching, exporting and signing in, and every change is
refused (`423 Locked`, error code `READ_ONLY`) on every replica at once.

1. A day or so ahead, schedule the window on **System health → Maintenance**
   with **Announce it now**: everybody sees when it will be and what will not
   work. Or switch it on by hand when you start.
2. Take a backup (backups keep running while read-only by default).
3. At the start, writes stop and background jobs that write pause after the
   batch in hand; replies already being written finish. Check **Health
   checks → Read-only mode**, and that `oci_read_only` is 1 on every replica.
4. Do the work: run the migrations, move or upgrade the database, replace
   replicas. A replica started meanwhile reads the switch from the database,
   so it is read-only too; set `OCI_READ_ONLY=true` on the new replicas if
   the database itself is being replaced and the setting may not be there.
5. Turn read-only off (or let the window end). Jobs resume on their next tick.

If the administration pages are not reachable, `OCI_READ_ONLY=true` (and
optionally `OCI_READ_ONLY_REASON`) on every replica and worker does the same;
it cannot be undone from the UI, only by unsetting it and restarting.

### Upgrading on Kubernetes

Run the same image as three kinds of pod: a pre-upgrade Job (`node
dist/migrate.js`), the API Deployment with `RUN_MIGRATIONS=false` (rolling
update), and, after the rollout finishes (`kubectl rollout status
deployment/oci-api`), a post-upgrade Job (`node dist/migrate.js --post`).
With Helm, these are `pre-upgrade` and `post-upgrade` hooks, as the bundled
chart does ([Kubernetes with Helm](#kubernetes-with-helm)). Give the
post-upgrade Job no `activeDeadlineSeconds` shorter than its index builds
(the preflight estimates them), and `backoffLimit` above zero: a rerun
resumes. The preflight runs as a one-off pod: `kubectl run oci-upgrade-check
--rm -i --restart=Never --image=<target image> --env=DATABASE_URL=... --
node dist/scripts/upgrade-check.js`.

### Background migrations

Each API replica runs the job `migrations.background` every 30 seconds. One
replica at a time works on a migration (a lease in the `background_migration`
table), in batches, each batch and its progress committed together, so a
crash, a restart or a failover loses or repeats at most one batch. A replica
that is stopped finishes its current batch and hands the migration on.
Batches wait while the database is under pressure:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BACKGROUND_MIGRATIONS_ENABLED` | `true` | Whether this replica runs batches at all. |
| `BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS` | `10000` | Wait while any standby's replay lag (`pg_stat_replication`) is over this; `0` turns the check off. Needs `GRANT pg_monitor TO <oci user>`, without which PostgreSQL hides the lag and the check sees none. |
| `BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS` | `300000` | Wait while a transaction in this database has been open longer (a long report, `pg_dump`); vacuum cannot clean up after batches meanwhile. `0` turns it off. |
| `BACKGROUND_MIGRATION_BATCH_TIMEOUT_MS` | `30000` | `statement_timeout` for one batch. |

On **System health → Background work** administrators can pause and resume a
migration and change its batch size and the pause between batches (taking
effect at the next batch; each change is in the audit log as
`background_migration.pause`, `.resume` or `.update`); auditors see the
same page read-only. A migration whose batches fail five times in a row stops
as `failed` with the error shown; resume it once the cause is fixed. Metrics:
`oci_background_migration_rows_processed`,
`oci_background_migration_progress_ratio` and
`oci_background_migration_status{status}`, and the job's own
`oci_job_runs_total{job="migrations.background"}`.

### Post-deploy settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUN_POST_MIGRATIONS` | same as `RUN_MIGRATIONS` | Whether this replica applies post-deploy steps itself (single instance). |
| `POST_MIGRATION_STATEMENT_TIMEOUT_MS` | `14400000` (four hours) | How long one post-deploy step may run; `0` means no limit. The lock timeout is `MIGRATION_LOCK_TIMEOUT_MS`. |

### Migration timeouts

From v0.11 every migration statement runs with a lock timeout and a statement
timeout, set for the migration transaction only:

| Variable | Default | Meaning |
| --- | --- | --- |
| `MIGRATION_LOCK_TIMEOUT_MS` | `3000` | How long a statement may wait for a lock (100–600000). |
| `MIGRATION_STATEMENT_TIMEOUT_MS` | `900000` (15 minutes) | How long one statement may run; `0` means no limit. |

The migration session also has a 10-second
`idle_in_transaction_session_timeout`, so a stalled migrator cannot keep its
locks.

Without a lock timeout, a migration that needs a table another session is
using (a long report, an open `psql` transaction, a `pg_dump`) waits as long as
that session does, and every later query on the table queues behind the
migration: one long transaction stops all reads and writes of the table. Now
the attempt gives up after the lock timeout, rolls back completely, and is
retried with backoff, up to ten attempts over about three minutes. Readers and
writers are held up for at most about one lock timeout at a time. If the lock
never frees, the migration fails with a message naming the table, the lock it
needed and the blocking session (pid, state, application and query). Let that
session finish or end it (`select pg_terminate_backend(<pid>)`), then run the
migration again. Other errors, including a statement timeout, fail at once.

Raise `MIGRATION_STATEMENT_TIMEOUT_MS` (or set it to `0`) only for a migration
known to scale with data, such as building a large index; the changelog says
when one does. Set both variables on whatever runs migrations: the `migrate`
job, or the API when `RUN_MIGRATIONS=true`. The bundled Compose file passes
both through to the `api` and `migrate` services from your shell or
`docker/.env`; left unset, the defaults apply. `pnpm db:migrate` (development
and CI) uses the same migrator and honours them too. Retry warnings appear in
the API's JSON log (`Database migration attempt n/10 timed out ...`, with the
relation, lock mode and blocking pids as fields).

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
`ENCRYPTION_KEY`, like provider keys. Before v0.11 replacing that key made them
unreadable; from v0.11 follow [Rotating `ENCRYPTION_KEY`](#rotating-encryption_key).
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
(from v0.11, generation 1; see
[Embedding generations](#embedding-generations-migration-0041))
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

#### Usage kept after an account is deleted (migration 0038)

Migration `0038_usage_kept_after_deletion` makes `user_id` nullable on
`usage_event`, `usage_record` and `quota_denial`, and replaces each table's
cascading key to `user` with one that sets `user_id` to null. Deleting an
account now keeps its usage history without the person; reports show it as
**Deleted accounts** ([Usage](admin/audit-reporting.md#deleted-accounts)).
Usage of accounts deleted before the upgrade is already gone.

Safe to apply before the new release is deployed: v0.9 replicas always write
`user_id`. Dropping `NOT NULL` changes only the catalog. Each new key is added
`NOT VALID` and the old key dropped, so nothing scans or rewrites a table and
every lock is brief, whatever the number of usage events. The new keys are
never validated, on purpose: the old keys already guaranteed every existing
row refers to an account, and a `NOT VALID` key is still checked for new and
changed rows and still sets `user_id` to null on deletion.

Also in v0.10 without a migration: Settings → Sharing, and the **Delete own
account** role switch, which is off for every role after the upgrade (see
[Self-service account deletion](admin/governance.md#self-service-account-deletion)).

### Upgrading to v0.11

#### Three-phase migrations (migration 0039, post-deploy steps 0001 to 0006)

Migration 0039 adds two tables, `oci_post_migration` and
`background_migration`; nothing else in the schema changes before replicas
are replaced. After every replica runs v0.11, `migrate --post` (step 7 of
[Upgrade](#upgrade)) builds two indexes on `message` concurrently:
`message_created_at_idx` (the admin overview's per-day counts) and the small
partial `message_error_created_at_idx` (the usage page's failed replies).
At 500,000 messages they took 0.4 s and 0.1 s and the first is about 11 MB;
at 20 million messages expect a minute or two and about 450 MB. Steps 0003
to 0005 add small partial indexes on `message(created_at)` for sent messages,
web searches and cancelled replies, and step 0006 adds
`thread(created_at) INCLUDE (temporary, parent_thread_id)`; together they
serve the usage page's Overview tab (at 4 million messages about 41 MB,
1.4 MB, 160 kB and 15 MB). Until they exist those pages are as slow as in
v0.10, and the Overview tab keeps its single pass over messages until step
0005 has finished.

#### Audit trail indexes (post-deploy steps 0007 and 0008)

An account's audit trail (its page's Recent activity and "Events by or
about" it in the audit log) also lists the bulk actions that named it, which
keep the accounts in `metadata.userIds` rather than `target_id`. Steps 0007
and 0008 build `audit_log_target_idx` on `audit_log(target_id)` and the GIN
index `audit_log_user_ids_idx` on `metadata -> 'userIds'` (small: only bulk
entries carry the key), so the trail is three index scans rather than a pass
over the whole log. Until `migrate --post` has built them the trail is
complete but read by scanning the table.

#### Usage rollups (migration 0040, background migration 0.11.usage-rollups)

Migration 0040 adds a nullable column `usage_event.in_rollup` (no default, so
no rewrite), three tables (`usage_rollup_hour`, `usage_rollup_model_hour`,
`usage_rollup_change`) and triggers on `usage_event` that record every change
to usage in the writer's transaction, including writes by v0.10 replicas still
running during the upgrade. Creating the triggers takes a brief lock on
`usage_event` (the migration's lock timeout and retries apply). Each write to
`usage_event` now also appends a row to `usage_rollup_change`; the job
`usage.fold-rollups` (every 30 seconds, on every replica, one at a time)
folds them into the hourly tables. If it fails (System health, jobs), reports
stay exact but slow down as the change log grows.

`migrate --post` schedules the background migration `0.11.usage-rollups`,
which adds the usage recorded before the upgrade to the rollups, 2,000 events
a batch; follow it on **System health → Background work**. Measured: 126,000
events in 64 batches over 10 seconds. Until it finishes, the Usage pages,
scheduled reports and budget checks read `usage_event` as v0.10 did, with the
same results; afterwards they read the rollups. It rewrites each
`usage_event` row once (the marker), so expect WAL and dead tuples
proportional to the table; autovacuum handles them. A future release that
drops the fallback will require it to be finished before upgrading.

The rollups hold exactly the usage events that are kept: usage history
retention prunes both together, and they keep no history of their own (the
per-day `usage_record` table still does).

#### Sign-in limits (no migration)

Better Auth's own sign-in limiter is off from v0.11; OCI's limits, shared in
Redis, count failed attempts per account, give a client address far more
room, and budget single sign-on per identity provider ([Sign-in
limits](#sign-in-limits)). `RATE_LIMIT_AUTH_PER_MINUTE` now counts **failed**
sign-ins per account; before, it counted every attempt per account and per
address. The address has its own limit, `RATE_LIMIT_AUTH_ADDRESS_PER_MINUTE`
(300). During the rolling upgrade v0.10 replicas keep their own limits.

Sessions are read from the database on every request from v0.11 (Better
Auth's five-minute session cookie cache is off), so a role change, a ban or a
revoked session applies on the next request on every replica, for about one
indexed read per request. Before, a browser already signed in kept its old
role, or its access after a ban, for up to five minutes.

#### Encryption key rotation (background migrations 0.11.reencrypt-*)

No schema change. v0.11 stores secrets in a versioned format that names the
key ([Rotating `ENCRYPTION_KEY`](#rotating-encryption_key)), which v0.10
cannot read, so during the rolling upgrade v0.11 replicas keep writing the
old format with the same key. Once `migrate --post` has finished (the
statement that no v0.10 replica is left; a single instance with
`RUN_MIGRATIONS=true` does it itself), every replica switches to the new
format within 30 seconds, and five background migrations rewrite the values
already stored (`0.11.reencrypt-provider-keys`, `-connector-credentials`,
`-connector-tokens`, `-webhook-secrets`, `-settings`; a few hundred rows each
on most instances, seconds). Nothing needs doing, but do not change
`ENCRYPTION_KEY` during the upgrade.

#### Embedding generations (migration 0041)

Migration 0041 adds two small tables, `embedding_generation` and
`embedding_generation_failure`; v0.10 never reads them. From v0.11, changing
the embeddings model on **Providers & Models → Embeddings** no longer empties
meaning-based search while passages are embedded again: the new model is a
new *generation* with its own table (`project_file_embedding_g2`, `_g3`, ...),
filled in the background by the `embeddings.rebuild` job on worker (or `all`)
replicas while searches keep using the current one, and searches switch to it
once it covers every passage ([Embeddings](admin/models-providers.md#embeddings)).
Details: [Database, embedding generations](dev/database.md#embedding-generations).

**During the upgrade.** Nothing is renamed or copied: the existing
`project_file_embedding` table becomes generation 1 under its current name, so
v0.10 replicas keep using it. Two things wait until the upgrade is complete,
that is until `migrate --post` has run after the last replica was replaced (a
single instance with `RUN_MIGRATIONS=true` does this itself): switching
searches away from generation 1, and dropping its table. A rebuild started
during the upgrade fills meanwhile, and the Embeddings tab says the switch is
waiting. Do not change the embeddings model on a v0.10 replica during the
upgrade: v0.10 would re-create generation 1's table at the new size; v0.11
then reports the mismatch (System health and the logs) and searches are
keyword-only until the model is chosen again on a v0.11 replica.

**Disk.** During a rebuild both generations exist. A generation takes about
8.7 KiB per passage at 1,536 dimensions (measured: 493 MiB for 58,000
passages at the `small` scale profile, 3.2 GiB for 390,000 at `medium`), so
roughly 5.8 bytes per dimension per passage for vectors of more than about
500 dimensions, which PostgreSQL stores out of line. Have free space for one
more generation of the new model's size before changing the model, plus WAL
for writing it. The replaced generation is dropped after the grace period;
until then both count towards database size and backups.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EMBEDDING_GENERATION_GRACE_MINUTES` | `1440` | How long a replaced generation's table is kept after searches switch away from it. |
| `EMBEDDING_REBUILD_PAUSE_MS` | `250` | Pause after every 64 passages a rebuild sends to the provider, to spread its load. |

The rebuild also waits while a standby lags or a transaction has been open
longer than `BACKGROUND_MIGRATION_MAX_REPLICATION_LAG_MS` /
`BACKGROUND_MIGRATION_MAX_TRANSACTION_AGE_MS` ([Background
migrations](#background-migrations)). Re-embedding is charged as usage to
each file's owner, as embedding an upload is; the tab shows the estimated
cost before a model change is saved.

#### Metrics, objectives and the web image (no migration)

- New metrics for the [service objectives and
  alerts](#service-objectives-and-alerts), all with fixed label
  vocabularies. `oci_http_request_duration_seconds` gains a `0.3` bucket, and
  `route` now names the handler that answered: `GET /api/threads/search` was
  counted as `/api/threads/:id` before, as were requests to other fixed
  routes registered before a `/:id` route. Dashboards filtering on
  `/api/threads/:id` see search leave it.
- The web image removes the caddy binary's `cap_net_bind_service` file
  capability; Caddy keeps listening on 8080 and the published port is
  unchanged. Docker Compose needs nothing; a container may now also run with
  `cap_drop: [ALL]`. Kubernetes manifests that added `NET_BIND_SERVICE` for
  Caddy can drop it (the chart does).

## Shutting down and draining

From v0.11 an API replica drains when it is stopped, so replacing replicas
one at a time (an upgrade, a rolling restart, a node drain) does not cut off
replies. On the first `SIGTERM` (or `SIGINT`) it:

1. Reports not-ready at once: `/api/health/ready` answers `503` with
   `{"status":"draining","reason":"Shutting down (SIGTERM); ..."}`.
   `/api/health/live` stays `200`, so nothing restarts it mid-drain.
2. Refuses new chat turns (`POST /api/chat`, and continuing after tool
   approvals) with `503`, `Retry-After: 1` and `Connection: close`, before
   reading them, so nothing is stored. The web app sends the turn again, up to
   twice, and the person sees nothing unless every attempt is refused; then
   it says the server is restarting and puts the message back in the
   composer, as for any other refused send. If that was the first message of
   a new chat and the person leaves it instead of sending again (for another
   page, or by closing or reloading the tab), the empty conversation is
   removed rather than left in their history; a reload opens a new chat with
   the text. Every
   other request is answered as usual, with `Connection: close`, so a proxy's
   pooled connections stop carrying new requests to the replica.
3. Stops its background jobs: no new runs start on it (another replica's tick
   picks the work up), and a job already running stops after the batch in
   hand. On an `all` replica it gets up to five seconds (replies come first);
   a worker (`OCI_ROLE=worker`) gives it the whole `SHUTDOWN_DRAIN_TIMEOUT_MS`.
4. Lets replies in progress finish, for up to `SHUTDOWN_DRAIN_TIMEOUT_MS`.
5. Past that limit, stops each remaining reply and saves it with what it has,
   marked **interrupted** (stored as `cancelled` with an `error_message`
   saying the server stopped). Its usage is settled from what the model
   reported, its Redis stream is ended so a client resuming it gets the end
   instead of waiting, and the conversation takes new messages at once. The
   web app shows the reason under the reply, with **Retry**.
6. Closes the HTTP server, Redis and the database pool, and exits `0`.

A second signal exits at once (code `1`).

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | `25000` | How long replies in progress may keep running after the signal (0–3600000). |

Set it **below the orchestrator's grace period** (the time between `SIGTERM`
and `SIGKILL`), leaving about five seconds for the final saves and, in
Kubernetes, the `preStop` delay as well. A reply longer than the limit is
saved as interrupted rather than lost; raise the limit (and the grace period)
if your replies are routinely longer.

A replica that is killed instead (`SIGKILL`, out of memory, a crashed node)
cannot drain. Its replies are recovered automatically; see
[Recovering an interrupted chat run](#recovering-an-interrupted-chat-run).

### Docker Compose and the bundled proxy

The bundled Compose file sets `stop_grace_period: 30s` on `api` (Compose's
default is 10 s), above the 25-second drain. `docker compose stop`, `up -d`
with a new image and `down` all drain.

The web container's Caddy finds API replicas by re-resolving the `api` name
every 2 s. Caddy runs no active health checks for upstreams found that way,
so the bundled `docker/Caddyfile` takes a replica out of rotation through
passive checks on real requests: a `503` from it, or a connection that is
refused or takes longer than 1 s, marks it down for 3 s
(`fail_duration 3s`, `max_fails 1`, `unhealthy_status 503`,
`dial_timeout 1s`), and `lb_try_duration 5s` sends a request whose
connection failed to another replica, whatever its method, trying again
every 250 ms (`lb_try_interval 250ms`). Each further
refused turn marks a draining replica down again. The mark outlasts the
client's two resends of a refused turn (1 s apart), which may arrive through
another web replica with its own mark. It is shorter than
`lb_try_duration` so that a single replica (the default Compose stack) is
never left with nowhere to go: a request that arrives while it is marked
waits out the 3 s and is served by the draining replica, which still
answers everything but new chat turns, including a resume of the reply it
is finishing. A draining replica also lets replay readers finish (up to
2 s) before it ends them. Its pooled
connections are kept for 30 s, below the API's 65-second keep-alive, so it
never sends a request on a connection the API is closing.

The API answers `503` only when a replica cannot serve: it is shutting down,
or (readiness only) its database has been unreachable for more than 30 s. A
request that fails because the database connection dropped answers `500`
marked retryable instead (see [Database failover](#database-failover)).
Keep it that way: an instance-wide `503`
from every replica would mark them all down for 3 s at a time.

While no replica can be reached (the API stopped or restarting), each
request to `/api` waits the 5 s and answers `502`. The web container logs
one error line for each (`"logger":"http.log.error"`, `no upstreams
available` or the failed connection). While the API name does not resolve,
the failed lookup behind it (`failed getting dynamic upstreams`) is logged
once every 10 s rather than on every try: the proxy's own messages (`http.handlers.reverse_proxy`) go to
a logger that keeps the first of each message every 10 s and one in 1,000
after it. Before, a 40-second API restart wrote over 1,000 lines. See
[Logs](#logs).

### Kubernetes

Removing a pod from a Service's endpoints and sending it `SIGTERM` happen at
the same time, so for a moment ingress controllers and kube-proxy still route
to a pod that is shutting down. A short `preStop` sleep lets them catch up
before the drain starts; the readiness probe then keeps the pod out.

```yaml
spec:
  # preStop (5) + SHUTDOWN_DRAIN_TIMEOUT_MS (25) + margin for the final saves.
  terminationGracePeriodSeconds: 40
  containers:
    - name: api
      env:
        - name: SHUTDOWN_DRAIN_TIMEOUT_MS
          value: "25000"
      lifecycle:
        preStop:
          sleep:
            seconds: 5 # Kubernetes 1.30+; older: exec ["sleep", "5"] (the image has sleep)
      readinessProbe:
        httpGet: { path: /api/health/ready, port: 3000 }
        periodSeconds: 2
        timeoutSeconds: 2
        failureThreshold: 1
      livenessProbe:
        httpGet: { path: /api/health/live, port: 3000 }
        periodSeconds: 10
        failureThreshold: 3
```

The grace period counts from the start of `preStop`, so it must cover the
sleep and the drain. Use a rolling update with `maxUnavailable: 0` so a
replacement is ready before a pod is stopped, and a PodDisruptionBudget so a
node drain stops one replica at a time.

### Other proxies and load balancers

- **Health checks**: point active checks at `/api/health/ready` with a short
  interval (2–5 s) and one failure to mark a target down. HAProxy:
  `option httpchk GET /api/health/ready` with `default-server inter 2s fall 1
  rise 2`. AWS ALB: the same path, and a deregistration delay at least
  `SHUTDOWN_DRAIN_TIMEOUT_MS` so replies in progress are not cut by the
  balancer.
- **Keep-alive**: keep the proxy's idle timeout for upstream connections
  below 65 s (NGINX `keepalive_timeout` in the `upstream` block, HAProxy
  `timeout http-keep-alive`).
- **Retries**: retrying a failed *connection* on another replica is safe for
  every method. A drain refusal (`503` with `X-OCI-Draining: 1`) is also safe
  to retry, since the API refuses it before reading it; the web app does so
  itself, so a proxy need not.
- **Streaming**: disable response buffering for `/api` (NGINX
  `proxy_buffering off`), as before.

## Process roles

From v0.11 one API image runs in one of three roles, set with `OCI_ROLE`:

| `OCI_ROLE` | Serves | Runs background jobs |
| --- | --- | --- |
| `all` (default) | The API | Yes, as before v0.11 |
| `web` | The API | No: work its requests start is handed to a worker |
| `worker` | Only `/api/health/live`, `/api/health/ready` and `/metrics` on `API_PORT` | Yes |

Background jobs are everything on a schedule or queued: imports, embedding
project files, conversation summaries (compaction), webhook deliveries,
scheduled and manual backups, compliance exports, retention and trash purges,
storage cleanup, usage reports, and the sweep that saves replies whose
replica died as interrupted. A `web` replica still does everything a request
needs on the spot: it stores and streams replies, indexes an uploaded project
file so it is searchable at once, renders a document someone downloads, and
recovers an interrupted reply when somebody opens or writes in its
conversation. Embedding that file, an import, a summary or a webhook delivery
it queues instead, and asks a worker to start it straight away with a
PostgreSQL notification (`LISTEN`/`NOTIFY` on `oci_job_requests`). If no
worker hears it, nothing is lost: the job's next tick (one to five minutes)
finds the queued work.

**A deployment of `web` replicas only runs no background work.** Run at least
one `worker` (or `all`) replica. Every replica writes a heartbeat to Redis
every 15 s; **System health → Background workers** turns red, and each `web`
replica logs a warning (then every ten minutes), when no `worker` or `all`
replica has written one for a minute. System health also lists the replicas
it has heard from and their roles. Without Redis, the worker check falls back
to the interrupted-reply sweep's recorded runs (every 15 s on whichever
replica runs jobs). **Run now**, **Back up now** and **Export now** on a `web`
replica are handed to a worker, which confirms it has taken the request
(`oci_job_request_acks`). They are refused with `409` while no worker is running,
and also when no worker confirms within 5 s. A worker that has just stopped or
crashed still looks alive for up to a minute, and a request it never hears
would be lost, so the refusal says the work has not started.

Jobs hold a PostgreSQL advisory lock while they run, so any number of `worker`
and `all` replicas can run side by side; each job runs on one at a time.
Workers need the same database, Redis, storage (`STORAGE_LOCAL_PATH` volume,
or the S3 settings) and `ENCRYPTION_KEY` as the API, and `APP_URL` for links in
the emails they send. Start them with `RUN_MIGRATIONS=false` after the
migration job.

**Sizing.** One worker is enough for most deployments; jobs run one batch at a
time and mostly wait on the database or a provider. Add a second for
availability (a node drain, an upgrade) rather than throughput. Give it the
memory of an API replica (imports and backups stream, but document rendering
and `pg_dump` need headroom) and less CPU. `web` replicas scale with traffic
and no longer lose CPU to embeddings, imports or backups.

**Readiness.** A worker reports ready (`/api/health/ready`, `200`, with
`"role": "worker"`) when it can reach the database, and `503` once it is
shutting down. It serves no traffic, so nothing routes on it; use it as the
probe that restarts a stuck worker together with liveness. On `SIGTERM` a
worker starts no new job, lets each running job finish the batch in hand, for
up to `SHUTDOWN_DRAIN_TIMEOUT_MS`, and exits; a job cut off later is picked up
by the next tick elsewhere.

### A worker with Docker Compose

The bundled file has an optional `worker` service (profile `worker`). To move
background work off the API container:

```bash
OCI_API_ROLE=web docker compose --profile worker up -d
docker compose --profile worker up -d --scale worker=2   # more than one
```

Without the profile, `api` runs as `all`, as before. Never put a worker behind
the web proxy (it answers `404` to everything but health and metrics).

### Workers on Kubernetes

Run two Deployments from the same image: `oci-web` (`OCI_ROLE=web`, behind the
Service and ingress, scaled on traffic) and `oci-worker` (`OCI_ROLE=worker`, no
Service except for metrics scraping, two replicas for availability). Give the
worker the same `terminationGracePeriodSeconds` and `SHUTDOWN_DRAIN_TIMEOUT_MS`
as the API; it needs no `preStop` sleep (nothing routes to it).

```yaml
# oci-worker
spec:
  replicas: 2
  template:
    spec:
      terminationGracePeriodSeconds: 40
      containers:
        - name: worker
          image: ghcr.io/ncecere/open-chat-interface/api:<version>
          env:
            - name: OCI_ROLE
              value: worker
            - name: RUN_MIGRATIONS
              value: "false"
            - name: SHUTDOWN_DRAIN_TIMEOUT_MS
              value: "30000"
          readinessProbe:
            httpGet: { path: /api/health/ready, port: 3000 }
            periodSeconds: 10
          livenessProbe:
            httpGet: { path: /api/health/live, port: 3000 }
            periodSeconds: 10
            failureThreshold: 3
```

The `oci-web` Deployment is the API one under
[Shutting down and draining → Kubernetes](#kubernetes), with
`OCI_ROLE=web`. During an upgrade, replace workers like any other replica;
jobs that stop mid-batch are safe to run again.

## Logs

The API and the worker write one JSON object per line to standard output
(`LOG_LEVEL`, default `info`). Lines carry identifiers (a run, thread, job or
connector id, a request path) and causes (an error's type, message, code,
stack and `cause` chain), not the values a database query was run with: when
a query fails, its statement is kept (cut to 500 characters) and its
parameters are replaced by `[redacted]`, so a database outage or failover
does not copy reply text or session tokens into your log store. PostgreSQL's
`detail`, which repeats row values (`Key (email)=(...) already exists`), is
redacted too; the constraint, table and column names stay. PostgreSQL's own
message can still quote the one value it rejects (`invalid input syntax for
type uuid: "..."`).

The same applies to Better Auth's messages, which go through the same logger
(marked `"component": "better-auth"`), and to the error text stored and shown
for a failed job run, background migration, backup, compliance export or file
embedding.

The web container's Caddy writes JSON lines to standard error. With the API
unreachable it logs one error line per failed `/api` request and, while the
API name does not resolve, the failed lookup once every 10 s; see
[Docker Compose and the bundled proxy](#docker-compose-and-the-bundled-proxy).

## Service objectives and alerts

From v0.11 OCI publishes service objectives, measured from its own metrics
over 30 days ([full definitions](dev/slo.md)):

| Objective | Target | Metric |
| --- | --- | --- |
| Availability: API requests not answered with a 5xx (health probes and draining refusals excluded) | 99.9 % | `oci_http_requests_total` |
| Reply start added by OCI, request arrival to the first model request, capacity waits excluded | p95 under 1 s | `oci_chat_reply_start_seconds` |
| Sidebar requests and opening a conversation | p95 under 300 ms | `oci_http_request_duration_seconds` |
| Conversation search | p95 under 1 s | `oci_http_request_duration_seconds` |

The model provider's own latency and errors are outside them and exported
separately (`oci_provider_first_output_seconds`, `oci_provider_throttled_total`,
`oci_chat_replies_total`).

[`deploy/monitoring/prometheus-rules.yaml`](../deploy/monitoring/prometheus-rules.yaml)
has recording rules for each objective, fast and slow burn-rate alerts
(1 h / 5 min and 6 h / 30 min) and operational alerts: database pool
saturation and replication lag, no background worker, stalled jobs, queue
backlogs, failed or stalled background migrations, the usage-rollup fold,
provider errors, throttling, latency and capacity waits, Redis, readiness
flapping, and replies interrupted by a drain. Load it with `rule_files`, or set
`metrics.prometheusRule.enabled` in the Helm chart, which renders the same
rules. [`deploy/monitoring/grafana-dashboard.json`](../deploy/monitoring/grafana-dashboard.json)
imports into Grafana with any Prometheus data source. Every API and worker
replica must be scraped (`METRICS_TOKEN`, [Observability](admin/observability.md#metrics)).
[docs/dev/slo.md](dev/slo.md) explains each alert and its first steps.

## Provider capacity

From v0.11 administrators can set limits per model provider and per model
(requests and tokens per minute, replies at once) under
[Providers & Models](admin/models-providers.md#provider-capacity). Every
replica enforces them together through Redis, and a message over them waits
in a fair queue instead of failing. With no limit set (the default) nothing
waits and no Redis key is written.

**Redis keys**, all under `oci:capacity:{<provider id>}:` (the braces keep a
provider's keys in one hash slot for Redis Cluster). Each change is one Lua
script, timed by Redis's own clock (`TIME`), never a replica's:

| Key | Type | Holds | Expires |
| --- | --- | --- | --- |
| `q` | sorted set | Waiting messages by queue order | Members leave when admitted, stopped, timed out or abandoned |
| `t:<run id>` | hash | A waiting message: model, estimated tokens, state | 10 s after its replica last polled it |
| `last:<person id>` | string | The person's latest queue position, for spacing | 10 minutes |
| `p:rb`, `p:tb`, `m:<model id>:rb`, `m:<model id>:tb` | hash | Request and token buckets (level and time) of the provider and each limited model | 3 minutes idle |
| `p:st`, `m:<model id>:st` | sorted set | Stream leases by expiry | A lease lapses 30 s after its last renewal (every 10 s while the reply runs) |
| `p:cool`, `m:<model id>:cool` | string | Pause after a `429`, as long as the provider asked | That long (at most a minute) |
| `adm` | sorted set | Admissions in the last minute, for the estimated wait | 2 minutes |
| `thr`, `waits` | sorted set | Throttles and waits in the last hour, for System health | 1 hour |
| `handoff:<prompt id>` | string | The place of a message handed back by a draining replica | 2 minutes |

**Replicas that crash.** A crashed replica's stream leases lapse within 30
seconds and its waiting messages leave the queue within 10, so it never holds
capacity for long. A replica polls its own waiting messages together, four
times a second, with one script per provider; any replica's poll admits the
head of the queue, whichever replica it waits on, and the owner picks the
admission up on its next poll (unclaimed, it lapses in 10 seconds).

**Without Redis** (not configured, or unreachable) each replica enforces the
whole limit on its own, so N replicas may together reach N times the limit;
the queue's order and fairness hold within each replica. A replica whose
Redis fails while messages wait moves them to its own queue, keeping their
order. The Providers tab and System health say which applies. Run Redis for
more than one replica.

**Draining.** A replica that begins draining hands its waiting messages back
at once rather than letting them wait through the drain: each ends without a
reply (saved as `cancelled`, "The server restarted before this reply
started"), its place is kept for two minutes, and the web app sends it again,
to a running replica, which takes the place and replaces the empty reply.
Nothing was sent to the provider, so nothing is billed twice. A person who
has closed the page sees the note and **Retry**.

**Retries.** Every reply (limits or not) sends a request the provider
refused for now (`429`, `408`, `409`, `5xx`, "overloaded") again before its
first output only, after `Retry-After` or with backoff: at most three
retries within a minute. This replaces the AI SDK's own two retries.

**Metrics** (per replica): `oci_provider_queue_waits_total`,
`oci_provider_queue_wait_seconds`, `oci_provider_queue_waiting`,
`oci_provider_throttled_total` and `oci_provider_retries_total`; see
[Observability](admin/observability.md).

## Database failover

From v0.11 OCI rides out a change of PostgreSQL primary (Patroni, a managed
service's failover, a restart behind a virtual IP). Tested on every pull
request by terminating every connection in the middle of a migration, a job,
a reply's final save and requests, and weekly against a real three-node
Patroni cluster under load; the design and the results are in
[docs/dev/failover.md](dev/failover.md). What to expect:

- **Reads** caught by the failover are run again within the request, once,
  and answered normally (a little slower).
- **Writes** caught by it are not repeated: they answer **`500`** with
  `"retryable": true` in the error body and the header `X-OCI-Retryable:
  database-connection`. The change may or may not have been saved; send it
  again if that is safe, or check first. `503` is never used for this (it
  means a replica is draining, and proxies take `503` replicas out of
  rotation).
- **Replies** being written keep streaming (they go through Redis); their final
  save waits out the failover for up to 30 s. If the database is away for
  longer, the reply is saved once it is back by the recovery described in
  [Recovering an interrupted chat run](#recovering-an-interrupted-chat-run): a
  reply that had finished is saved as complete (its token counts unknown), not
  as interrupted. A new message whose saving meets the failover is retried for
  up to 10 s.
- **Background jobs** stop after the batch in hand when their lock goes with
  the old primary, and the next tick continues on the new one. Imports resume
  where they stopped. A tick whose lock connection is closed as it opens
  connects again and runs.
- **Readiness** stays `200` (`"status": "degraded"`) for the first 30 s the
  database is unreachable, so a failover does not take every replica out of
  rotation at once; after that it answers `503`. Its database check gives up
  after 1 s and counts as failing, so readiness answers within about a second
  even when the database's address drops packets or its name is slow to
  fail to resolve; give probes a timeout of at least 2 s.
- **Migrations** are one transaction; a failover rolls the attempt back and
  rerunning the migrate job starts cleanly.

In front of the cluster, use something that closes connections to a node that
stops being primary: HAProxy checking Patroni's REST API (`option httpchk`,
`http-check send meth GET uri /primary`, `default-server ... init-state down
on-marked-down shutdown-sessions`; `tools/failover-drill/haproxy.cfg` is a
working example), a pooler, or the provider's endpoint. A connection that
silently vanishes is otherwise noticed only by TCP keepalive, after minutes.
`CONTROL_DATABASE_URL` connections are session-mode or direct (jobs and
migrations hold advisory locks; the worker uses `LISTEN`); `DATABASE_URL` may
be a transaction-mode pooler ([connection pooling](#connection-pooling)).

With asynchronous replication the last moments of committed work can be lost
in an unplanned failover. OCI's jobs and the final save are safe to repeat, but
a reply or setting saved in those moments may need saving again.

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
window. Account deletion keeps the account's usage history without the person
(migration `0038_usage_kept_after_deletion`, `user_id` set to null); such
events are pruned by age even when unresolved, and the sweep skips them.
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
500 instead of pretending the run is absent (not 503, which the bundled proxy
reserves for a replica that is draining). Already-idle readers recheck every
two seconds. Missing ownership or validation failure ends only that reader with
the friendly replay error. For an owned terminal run, the reader refreshes a
bounded cache-tail snapshot: it closes cleanly only after forwarding a real SDK
finish frame, or when the cache itself records the run as cancelled (stopped
or interrupted, which have no finish frame); otherwise it reports unavailable
replay. An idle reader also checks whether the run's producer is still alive
and, if it is gone, ends the run as interrupted
([Recovering an interrupted chat run](#recovering-an-interrupted-chat-run)). This covers completion
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

From v0.11 recovery is automatic. While a reply is being written, its
producer refreshes a short-lived heartbeat key in Redis
(`oci:chat-stream:run:RUN_ID:alive`) every 5 seconds and the claim's
`updated_at` every 10. A run is treated as interrupted only when **both**
have been silent for 20 seconds and Redis has captured no event from it in that time (a producer on a
release before v0.11 has no heartbeat, but its events show it is alive during
a rolling upgrade). Requiring both means a database failover or a producer
that lost Redis does not look like a crash; a run on the replica doing the
check is never touched. Without Redis, PostgreSQL decides alone.

Three things notice an interrupted run: a client resuming it (checked when
the reader is idle, then every 5 s), a new message in its conversation
(checked before refusing it with 409), and the background job
`chat.recover-interrupted-replies` (every 15 seconds, runs started in the last
six hours). Recovery ends the run's Redis stream, so every reader finishes with
what was captured; saves the reply as `cancelled` with the interrupted
message, rebuilt from the captured stream so it keeps what the person saw (a
reply whose captured stream reached the model's finish, so that only its
final save was lost, is saved as `complete` instead, with its token counts
unknown);
settles the usage reservation as unknown (keeping its estimate, as the quota
sweep does); and frees the person's concurrency slot. A producer that was
only paused and saves later replaces the interrupted copy with its real
reply, and its usage report amends the settlement.

Until a run is recovered, a new message in its conversation is refused with
409. Once the claim has gone more than 12 seconds without a refresh (longer than a live
producer ever leaves it) the refusal says the previous reply was interrupted
and is being recovered, and gives the seconds left in `Retry-After`; before
that it says a response is already being generated.

A crash therefore leaves a reply hanging for about 20 to 30 seconds to a
person resuming it or sending again, and at most about 40 seconds otherwise.

The manual procedure below remains for a claim that is not recovered: one
older than six hours that nobody opens, or an instance whose replicas run a
release before v0.11. Normal client disconnection is not proof that a model
stopped; do not clear a claim merely because Redis is empty or its TTL
elapsed.

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

Neither the automatic nor the manual recovery is fencing: a producer that
comes back after its run was recovered can still save its final reply.

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

From v0.11, once `migrate --post` has run, stored secrets are rewritten in a
format v0.10 cannot read (see [Encryption key
rotation](#encryption-key-rotation-background-migrations-011reencrypt-)).
Rolling the images back to v0.10 after that point needs the database backup
taken before the upgrade, as rolling back past any post-deploy step does.
