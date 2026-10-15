# Spec: scale-on-cluster

Module of [SPEC.md](SPEC.md) (v0.13). Depends on `accent-search` (measure the code that ships). Shared commands, structure, style, testing and boundaries are in SPEC.md; this file adds what is specific to this module. Status: **approved 2026-10-13: every recommendation in "Open questions" accepted, including the homelab change `--pg-node` (ask-first, approved here) and dropping the `nfs-dev` fallback. Exception: the `large` run (gate G3) waits for the maintainer's explicit go-ahead when the earlier gates are done, because it runs on the shared cluster.** (issue #387, SPEC.md decision 4). Written from reading only; nothing was run and no cluster was touched. Paths are relative to this repo unless prefixed `homelab:` (`~/homelab/bitop-talos`).

## Objective

Run `tools/scale` up to `large` against a `dev-env` environment in namespace `dev-oci`, and publish the results against the service objectives (`docs/OPERATIONS.md` "Service objectives and alerts", `docs/dev/slo.md`), without harming the production services that share the cluster. `docs/dev/slo.md:35` and `docs/dev/scale-harness.md:56` both say `large` has never been run.

**Today (v0.12.1 plus the accent-search branch), what is missing.** `run.sh` is a Docker-only program. Nothing in `tools/scale` can address a Kubernetes environment.

| `run.sh` / harness today | Assumption | Needed on the cluster |
|---|---|---|
| Builds images locally (`run.sh:158-159`) | Docker, the checkout | None: `dev-env up oci <name> --ref <branch>` uses the `dev-<sha12>` branch images (`oci.py:resolve`). |
| Own compose project `oci-scale` (`run.sh:104`, `compose.yaml`), PostgreSQL 17 (`compose.yaml:34`) | Tuned server: `shared_buffers` 1GB, `max_connections` 400, WAL and parallel settings (`compose.yaml:36-70`) | dev-env's CNPG Postgres **18** sets only `max_connections: 200` (`homelab:.../templates/postgres.yaml:51`). The harness's settings must be applied (`kubectl patch` of the `Cluster`, a restart) and recorded. |
| `create extension pg_stat_statements` (`run.sh:165`), preloaded by a flag (`compose.yaml:38`) | Server flag | CloudNativePG adds the library when a `pg_stat_statements.*` parameter is set (CNPG docs, found by web search, **not verified here**). Setting `pg_stat_statements.max` in the same patch should do it. |
| Migrate, generate, then start the API (`run.sh:167-190`, `RUN_MIGRATIONS=false`) | API not running while the generator drops and rebuilds indexes | dev-env's API and worker are already running and migrated, with `RUN_POST_MIGRATIONS=true` (`oci.py:66`). Scale both to 0 for generation; `--reset` is needed (an admin exists). |
| Generator needs a superuser and direct access (`generate-setup.mjs:80-87`, `generate.mjs:91`) | `postgres` user over a published port | A pod in `dev-oci` using the CNPG superuser Secret (`enableSuperuserAccess: true`, `postgres.yaml:35`) and the `-rw` Service. The Secret is read by the pod, never printed. Exact Secret and Service names are CNPG conventions, **not verified**. |
| `tools/scale` mounted into the API image (`compose.yaml:tools`) | A checkout | The API image does not contain it (`docker/api.Dockerfile` copies only `apps/api` and `packages`). Ship it as a gzip tarball in a ConfigMap (268 kB uncompressed, results excluded; limit 1 MiB). |
| Stub model service (`compose.yaml:91`), its URL stored in the database by the generator (`generate.mjs:129`) | DNS name `stub` | A Deployment and Service in `dev-oci`; pass its Service URL as `--stub-url`. Same-namespace traffic is allowed (`homelab:.../base/network-policies.yaml:37`). Whether OCI accepts a cluster Service name as a provider address is **unverified**. |
| k6 from `grafana/k6:1.3.0` (`compose.yaml:176`) | Docker | In-cluster pod, or the laptop through a port-forward (below). |
| Harness environment: rate limits, retention windows, `METRICS_TOKEN` (`compose.yaml:22-30`), web `TRUSTED_PROXIES` (`compose.yaml:166`) | Set in compose | dev-env sets only `RUN_POST_MIGRATIONS` (`oci.py:66`) and no `web.trustedProxies`, so each simulated person's `X-Forwarded-For` is ignored and the sign-in storm hits Better Auth's per-address limit (`scale-harness.md:420`). Fix with `kubectl set env` on the environment's own deployments, `METRICS_TOKEN` from a generated Secret. No homelab change. |
| `report.mjs collect` resolves DNS name `api` and fetches `:3000/metrics` (`report-db.mjs:61,76`) | Compose service name | The chart renders a headless API Service (`deploy/helm/.../api-service.yaml:26-33`), so DNS returns every ready replica. Make host and port configurable (`SCALE_API_HOST`). Release-prefixed name **to confirm**. |
| Report says "Docker … Everything shares that machine" (`report-render.mjs:205`) | Laptop | An `environment` block (below). |
| Disk preflight with `docker run … df` (`run.sh:143-150`) | Docker VM | A pool preflight (below). |

Two comparability facts that are **not** gaps but change the numbers:

1. **Post-deploy steps and background migrations run on the cluster.** `run.sh` never runs `migrate --post` (`scale-harness.md:479,644`); dev-env's worker does, within a minute (`dev-env/README.md` "Migrations"). On v0.13 that means `0.13.message-search-folded` backfills the 20 M messages after generation. From the measured rate (300,493 messages in 160 s, `scale-harness.md` accent section) that is roughly 3 hours of background writes at `large` (my extrapolation).
2. **Topology differs.** dev-env runs the API in role `web` plus a separate worker (`oci.py:61-65`, chart `oci.apiRole`); the harness's replicas run in role `all`. dev-env's shape is closer to a Helm deployment.

**Users:** the maintainer (is `large` safe and what are its numbers), operators sizing a deployment, and anyone reading `slo.md`.

**Approach (smallest design):**

1. **A new `tools/scale/cluster.sh`**, not more branches in `run.sh`. It drives `dev-env`, `kubectl` and manifests in `tools/scale/k8s/`, reusing `generate.mjs`, `k6/*.js`, `report.mjs` unchanged except as listed under Files.
2. **One run Job per run.** Pod `scale-run` with ordered init containers (extract, generate, warm, k6 main, collect, k6 retention, collect, render) sharing an `emptyDir` `/results`, and a last `hold` container so `kubectl cp` can fetch results. `activeDeadlineSeconds` bounds it even if the laptop dies. Phases cannot be re-run alone in v1 (open question 11).
3. **k6 and the stub on the same node** (the load node), **Postgres on a different, pinned node** (the database node); API, web and worker on the load node.
4. **Guard in front**: preflight, watcher, TTL and a trap-based teardown (next section).

### k6 in the cluster or on the laptop

| | In-cluster pod (recommended) | Laptop through `dev-env forward` |
|---|---|---|
| Measurement | Stub and k6 share one node clock, which the reply-start measure needs (`scale-harness.md:221`: stub arrival minus k6 send time). | Laptop and node clocks differ by their NTP error; the tunnel's latency is added to every request and to reply start. |
| Capacity | Direct to the web Service. | One `kubectl port-forward` carries 150+ VUs and 80 sign-ins/s; it can become the bottleneck. |
| Cluster risk | Uses node CPU (limited, pinned). | Every byte goes through kube-apiserver on the control-plane nodes we are protecting. |
| Effort | A pod spec; `SCALE_ORIGIN` set to the app URL `http://localhost:<port>` (as `compose.yaml:183` does). | Almost none; reuse the compose k6 service. |

Use the laptop only for hand exploration. Every published cluster number comes from the in-cluster path.

### PostgreSQL 18 against production's 17

`AGENTS.md:39` and `homelab:.../shared/clusterimagecatalog.yaml` say dev databases are 18 because CNPG's pgvector images exist only for 18. A cluster result is therefore "OCI on PostgreSQL 18 with pgvector 0.8.7" (`postgres.yaml` header), not production's 17. Planner and I/O changes in 18 (from my knowledge of its release notes, not re-checked) can move scan-heavy statements either way: the admin pages, the person-filtered keyword search (finding 5), `rankProjectChunks`. Mitigation: a **version bridge** on the laptop at `medium` with `SCALE_POSTGRES_IMAGE=pgvector/pgvector:pg18` (an existing variable, `compose.yaml:34`) versus the 17 default, same commit, so version delta and hardware delta are reported separately. The pg18 image may need a different data-volume path in compose (unverified). Verdicts for `large` say "on PostgreSQL 18"; PostgreSQL 17 at `large` stays unmeasured and is stated as such.

## Safety design for `large` on the shared cluster

Facts verified in the homelab repo that shape it: the three nodes are all control planes, so every node runs etcd (`talos/inventory.yaml`); `local-dev` is Miroir `ext4`, `Delete`, `WaitForFirstConsumer`, one replica (`storageclass.yaml:33-41`); project quota 200Gi on `talos-cp-1` and `-3` (NVMe), 100Gi on `-2` (SATA) (`nodes.yaml:7,21,35`); the alert `LocalSSDPoolQuotaNearlyFull` fires above 0.85 allocated/capacity for 5 m (`bitop-kubernetes.yaml:25-31`); dev pods get PriorityClass `dev` (-100, never preempts) and a 50m/128Mi default request but no limit (`priorityclass.yaml`, `limitrange.yaml`); the namespace enforces Pod Security `restricted` (`oci/namespace.yaml:8`), so every pod needs `runAsNonRoot`, dropped capabilities, no privilege escalation, `RuntimeDefault` seccomp.

| Control | Design |
|---|---|
| **Scope guard** | Every `kubectl` call goes through one helper that adds `-n dev-oci`; `-A`, `--all-namespaces` and any other namespace are refused (unit-tested). Every object carries `dev.bitop.dev/env=<name>`, so `dev-env down` and the reaper find it (`common.py:23-25`, `reaper.py`). Jobs, Deployments, Services, Secrets, ConfigMaps and PVCs are all in both lists. |
| **Volume** | `dev-env up oci <name> --pg-size <size>`. `--pg-size` exists (`dev-env:202`, default `5Gi`, passed to the template at `:105`) but the README does not document it. Sizes: tiny 5Gi, small 15Gi, medium 40Gi, large **150Gi** (the profile's estimate × 1.5 + 10, as `run.sh:150`, and decision 4: 75% of 200Gi, under the 85% alert). |
| **Pinning** | The `Cluster` template has no affinity (`postgres.yaml`), and with `WaitForFirstConsumer` the volume binds where the pod first lands, so a later patch is too late. **Needs a homelab change (ask first):** `dev-env up --pg-node <node>` filling a `spec.affinity` node selector. Until it exists only `tiny` and `small` may run, and the run aborts if the bound volume's node (the PVC's `volume.kubernetes.io/selected-node` annotation, to verify) is `talos-cp-2`. Load-side pods are patched with `nodeSelector` on the other node. |
| **Requests and limits** (`kubectl patch`/`set resources` after `up`; **starting values, to be set from node capacity, which I did not read**) | Postgres 2 CPU / 6Gi requested, limits 4 CPU / 8Gi; API 1 CPU / 1Gi, limit 2 / 2Gi per replica; k6 limit 2 CPU / 2Gi; generator `--workers 2` (`generate.mjs:143`, default is CPUs up to 8), limit 2 CPU / 2Gi. Kubernetes has no disk-I/O limit, so the generator's WAL and index-build writes to the NVMe that also holds etcd are bounded only by CPU and workers: **residual risk, to be measured at `medium` first**. |
| **Postgres settings** | The harness's values (`compose.yaml:36-70`) patched into the `Cluster`, then `select name, setting from pg_settings` saved in the results. |
| **Preflight** (read-only, before `up`) | Context is the bitop cluster; `dev-env list oci` shows no other environment; all nodes Ready with no Memory/Disk/PID pressure; on the database node the pool's allocated ratio plus the request stays ≤ 0.80 (so ≥ 40 GiB of headroom remains after 150Gi); node filesystem free space and CPU idle read from the kubelet summary (`/api/v1/nodes/<n>/proxy/stats/summary`, **unverified**); etcd members healthy and fsync p99 below the baseline for 5 minutes. Prints what it read; stops on any miss. **Needs measuring:** the node CPU/idle threshold (proposal: below 50% busy over 15 minutes on both nodes). |
| **Watcher** (laptop process, every 15 s, until teardown) | **etcd:** wal-fsync p99 over 30 s above **25 ms** twice in a row, or above 100 ms once, or any leader change, or `/readyz/etcd` failing: abort. Warn at 10 ms (etcd's own target; search summary of the etcd FAQ, not re-read). **Volume:** used bytes of the data volume above **120 GiB** (80% of 150Gi; `df` in the Postgres pod and `pg_database_size`): abort. **Node:** any pressure condition, or database-node filesystem free below 20% (**needs measuring**: `bitop-kubernetes.yaml:34` warns the quota must not be raised without checking boot-filesystem headroom). **Not usable as a live signal:** the 0.85 pool ratio, which may be nominal allocation and so static (open question 6). All numbers are proposals, to be replaced by baselines from the `medium` gate. |
| **Abort** | Delete the run Job first (stops writes), then teardown; `--keep-on-abort` keeps the environment only until its TTL. |
| **TTL** | `--ttl`: tiny 2h, small 3h, medium 4h, large 8h (the default; `dev-env:200`). The Job's `activeDeadlineSeconds` is the TTL minus 30 minutes. The reaper (`reaper-cronjob.yaml:57`, every 5 minutes) is the backstop; renewal is manual (`dev-env renew`). |
| **Teardown** | `trap` on EXIT, INT, TERM, HUP runs `dev-env down oci <name>`, then verifies that `kubectl -n dev-oci get all,pvc,secret,configmap -l dev.bitop.dev/env=<name>` is empty and, for medium and large, that the node's pool allocation returned to its pre-run value. A `kill -9` or power loss cannot be trapped: the Job deadline and the TTL bound it, and no watcher runs meanwhile (stated residual risk). |
| **Quiet time** | Start in the maintainer's night hours; log start and end. Production backup and Flux schedules are not in what I read (open question 8). |

## Acceptance criteria

### Tooling
- `tools/scale/cluster.sh --profile tiny|small|medium|large --name <env>` (proposed interface) creates the environment, applies the harness settings, runs the phases of `run.sh` in cluster, copies results to `tools/scale/results/<profile>-cluster-<date>/`, and tears down. `--dry-run` prints every step and calls none of `kubectl`, `helm`, `docker`, `dev-env`.
- `large` refuses to start unless the pin exists (database-node check passes), the preflight passes and the maintainer passes `--yes-large`.
- Harness env set by `kubectl set env` and a generated Secret; nothing secret is printed or written to results.
- `report.mjs` honours `SCALE_API_HOST`; `report.json` carries an `environment` block (below); the Docker sentence is not printed for a cluster run.

### Safety
- A fire drill on `tiny`: a threshold forced to 0 aborts the run, deletes the Job and removes everything labelled; the check output is saved.
- On `medium` and `large` no object exists outside `dev-oci`, nothing remains afterwards, and production's namespace is not read or written.

### Results
- `baseline-medium-cluster` and `baseline-large-cluster` (`.md` and `.json`) committed in `tools/scale/results/` (the `.gitignore` allows `baseline-*`); raw directory stays ignored.
- Every service objective has a row with a verdict (below). `docs/dev/scale-harness.md` gains "Large on the cluster", the "has not been run" sentence (`:56`) is replaced, `slo.md:35` is updated to say `large` was measured on a shared cluster, on PostgreSQL 18, not dedicated hardware.

## What is published and how it is read

**Labels (every cluster report carries all of them):**

| | Laptop baseline (`baseline-small/medium`) | Cluster |
|---|---|---|
| Hardware | Apple M4 Pro, 48 GB, Docker VM 12 CPUs / 7 GiB | Nodes `talos-cp-<n>` NVMe: CPU, memory, kernel from `kubectl get node -o json` (read at run time) |
| Sharing | Other compose stacks on the machine | Production services and other dev environments on the same nodes |
| PostgreSQL | 17, `pgvector/pgvector:pg17` | 18, pgvector 0.8.7; settings from `pg_settings` |
| Topology | One machine, API role `all` | DB node, load node, API `web` plus worker |
| Storage | Docker volume | Miroir `ext4` loop file, 150Gi |
| Load generator | k6 container, same machine | k6 pod, load node |
| Background state | v0.12 search path, no post steps | State named in the report (pending or finished backfill) |

**Against the objectives.** Per objective: target, k6 p95 from the report, verdict.

| Objective (`slo.md`) | Harness metric | Verdict rule |
|---|---|---|
| Sidebar and conversation open p95 < 300 ms | `sidebar_ms`, `conversation_open_ms` | met / not met |
| Reply start p95 < 1 s | `chat_pre_model_ms`, `project_pre_model_ms` | as above; the large-project bucket reported apart (baseline missed it at `medium`) |
| Search p95 < 1 s | `search_ms` | as above |
| Availability 99.9% (5xx) | 5xx share of `oci_http_requests_total` over the run | needs `collect` to keep the `status` label (it sums requests without it, `report-db.mjs:87`); k6's own threshold is 1% (`scale-harness.md` Scenarios) |

A **pass** on the shared cluster is evidence the objective holds. A **miss** is reported with `pg_stat_statements` evidence and the etcd and node readings at that time; it is "inconclusive" when the node was visibly busy with other work, and is not stated as a product finding until repeated or explained.

**Done** means: `tiny`, `medium` and `large` have each run once at the proposed commit through the gates below, the cluster is clean, the baselines are committed, and `slo.md` and `scale-harness.md` say what was and was not shown.

## Files touched (expected)

**This repo:** `tools/scale/cluster.sh`, `tools/scale/k8s/*.yaml` (stub, run Job, Secret template), `tools/scale/lib/cluster-guard.mjs` (pure threshold and preflight decisions), `scripts/scale-cluster-guard.test.mjs` (CI already runs `scripts/*.test.mjs`, `ci.yml:120-121`), `tools/scale/lib/report-db.mjs` (`SCALE_API_HOST`, status label), `tools/scale/lib/report-render.mjs` (environment block), `tools/scale/README.md`, `docs/dev/scale-harness.md`, `docs/dev/slo.md`, `AGENTS.md` (a short "Scale runs on the cluster" paragraph; it currently says no limits), `tools/scale/results/baseline-*-cluster.*`, `CHANGELOG.md` (one dev-tooling line). **Not** `.github/workflows/scale.yml`: CI has no cluster access and must not gain any.

**Homelab, all ask first:** `tools/dev-env/dev-env` and `devenv/oci.py` (`--pg-node`), `kubernetes/platform/dev-areas/templates/postgres.yaml` (optional affinity), `tools/dev-env/README.md` (document `--pg-size`, `--pg-node`), `tools/dev-env/tests/` (a render test). Optional: scraping etcd's metrics (open question 1). None is needed for the `tiny` gate.

## Commands (module-specific)

```sh
DEVENV=~/homelab/bitop-talos/tools/dev-env/dev-env          # verified flags below
$DEVENV up oci <name> --ref <branch> --ttl 4h --pg-size 40Gi   # --ttl, --pg-size, --ref exist (dev-env:198-202)
$DEVENV status oci <name>; $DEVENV renew oci <name> --ttl 2h; $DEVENV down oci <name>
tools/scale/cluster.sh --profile tiny --name scale-t1 --dry-run   # proposed
tools/scale/cluster.sh --profile medium --name scale-m1 --db-node talos-cp-3   # proposed
node --test scripts/scale-cluster-guard.test.mjs
tools/scale/run.sh --profile medium     # laptop, PostgreSQL 17 (control)
SCALE_POSTGRES_IMAGE=pgvector/pgvector:pg18 tools/scale/run.sh --profile medium   # version bridge
```

## Testing strategy

**In CI (no cluster):** unit tests of the guard with recorded samples (abort exactly at the thresholds, not below; preflight decisions); a test that the scope helper refuses `-A` and any namespace but `dev-oci`; rendered manifests validated with kubeconform (installed by `helm.yml:88`) and asserted to carry the env label and the restricted security fields; `bash -n` and shellcheck on `cluster.sh`; `--dry-run` run with a PATH that fails if `kubectl`, `helm`, `docker` or `dev-env` is called; a render test of the environment block.

**Only by hand on the cluster, in gates, each reviewed before the next:**
- **G0** `--dry-run`, and a read-only preflight.
- **G1 `tiny`** (about 15 min, 5Gi): the pipeline end to end: pod security, stub reachability and URL acceptance, superuser Secret, `pg_stat_statements`, results copied, teardown clean, **and the fire drill**.
- **G2 `medium`** (40Gi, pinned): measure etcd fsync before, during and after (generation is the heavy part), pool and volume use, then set the watcher's thresholds from data. Compare with a laptop `medium` run **on the same commit** (the baseline is `d31bfe1`, v0.10.2) and with the version bridge.
- **G3 `large`** (150Gi, pinned, night): only after G2's numbers are in this file.

## Boundaries (module-specific)

- **Always:** pin to cp-1 or cp-3; run the preflight and the watcher; label every object; set the TTL; tear down on every exit path; record environment labels in the report; one large run at a time.
- **Ask first:** any change in `~/homelab/bitop-talos` (the list above); running `large`; raising a threshold after an abort; keeping an environment past its TTL; changing the harness's own settings so numbers stop being comparable.
- **Never:** touch `open-chat-interface` or any namespace but `dev-oci` (reads included); use `talos-cp-2` for the volume; print or commit secrets; run `large` without a working watcher and pin; publish a cluster number without its labels; run from CI.

## Success criteria

The acceptance criteria hold; the three gates passed in order; `large` ran at least once and its baseline is committed; the cluster and the pool were left as found; the 17-versus-18 caveat is in every cluster report.

## Decisions (were open questions; every recommendation accepted, 2026-10-13)

1. **How does the watcher read etcd fsync?** I found no etcd scrape in `homelab:kubernetes/platform/observability-*` and did not query anything live. Options: etcd's metrics endpoint if Talos exposes it (unverified), kube-apiserver's `/metrics` (`etcd_request_duration_seconds`, a proxy), or a new scrape (homelab, ask first). *Recommend:* confirm with the owner what exists; if only the apiserver proxy, use looser thresholds and add the scrape as a follow-up.
2. **Pinning needs a homelab change.** *Recommend:* approve `--pg-node` (small, testable); until then no `medium` or `large`.
3. **Which background state is the `large` number?** Pending backfill matches the laptop baseline; finished matches what operators live with, after about 3 hours (item 1 above). *Recommend:* measure `medium` in both states (cheap), `large` once in the finished state.
4. **API topology.** *Recommend:* keep dev-env's `web` plus worker, label it.
5. **Postgres settings.** *Recommend:* patch in the harness's values so only hardware and version vary, and save `pg_settings`.
6. **What does `miroir_pool_allocated_bytes` count** (nominal allocation or bytes used), and is capacity 200Gi or the loop file? Not verifiable from files. *Recommend:* read it once during G1 and keep live volume `df` as the watcher's signal.
7. **Node capacity** (CPU, memory) was not read, so the requests and limits are placeholders. *Recommend:* the preflight prints capacity and the values are fixed in G1.
8. **Quiet time**: backup and Flux windows are not in what I read. *Recommend:* ask the maintainer.
9. **Does OCI accept `http://<service>.dev-oci…` as a provider address**, and do the Secret and Service names match CNPG's conventions? *Recommend:* G1 proves both.
10. **SPEC.md decision 4's fallback `nfs-dev` does not fit.** `storageclass.yaml:1-8` and `dev-areas/README.md` ("Pitfalls") say PostgreSQL cannot initialise on NFS (the NAS squashes writes to uid 1024). *Recommend:* drop it: if the pool is too full, run `medium` on the cluster and `large` on a self-hosted machine with 125 GB free (`scale.yml`'s existing route), or ask to enlarge the quota.
11. **Re-running load on kept data** needs `fixtures.json` (132 kB at `small`, larger at `large`; over the ConfigMap limit is possible). *Recommend:* not in v1; a failed `large` run restarts from generation.
12. **Is the laptop PostgreSQL 18 bridge possible** with the pgvector pg18 tag and the compose volume path? *Recommend:* try at `small` first.

**Not verified:** every kubectl, Talos or Miroir behaviour above marked unverified; CNPG's automatic `pg_stat_statements`; Docker Hub access for `grafana/k6` from the nodes; whether `dev-env` still matches the files I read (homelab HEAD `ef25e56`); the `small-2026-10-14` results directory carries a date after today's, which I did not investigate.
