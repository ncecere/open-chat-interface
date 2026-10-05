# Open Chat Interface Helm chart

Runs Open Chat Interface (OCI) on Kubernetes: the API, an optional background
worker, the web proxy, and the migration jobs that make upgrades
zero-downtime. PostgreSQL, Redis and S3-compatible storage are external: use
an operator (CloudNativePG, Crunchy, Zalando/Patroni; a Redis operator with
Sentinel) or managed services. The chart bundles neither.

The chart is released with the application: chart `0.11.0` deploys images
`v0.11.0`. Operations, upgrades and troubleshooting are in
[docs/OPERATIONS.md, "Kubernetes with Helm"](../../../docs/OPERATIONS.md#kubernetes-with-helm).

## What it runs

| Resource | Purpose |
| --- | --- |
| Deployment `<release>-api` | The API, `OCI_ROLE=web` when the worker is enabled (otherwise `all`). Rolling update with `maxUnavailable: 0`, `preStop` sleep, drain on `SIGTERM`. |
| Deployment `<release>-worker` | Background jobs (`OCI_ROLE=worker`): imports, embeddings, summaries, webhooks, backups, compliance exports, retention, background migrations. Serves only health and `/metrics`. |
| Deployment `<release>-web` | Caddy from the web image: the app, and the same-origin `/api` proxy that decides the client address. |
| Service `<release>-web` | Everything (the app and `/api`) goes here; point the Ingress or HTTPRoute at it. |
| Services `<release>-api`, `<release>-api-headless` | The headless one is how Caddy finds API pods: it balances across them itself and takes a draining one out of rotation. |
| Jobs `<release>-migrate`, `<release>-migrate-post` | Helm hooks: `migrate` before the rollout, `migrate --post` after it. |
| PodDisruptionBudgets, NetworkPolicies, optional HPA, Ingress, HTTPRoute, ServiceMonitor, PVC | See the values below. |

## Install

```bash
kubectl create namespace oci
kubectl -n oci create secret generic oci-runtime \
  --from-literal=DATABASE_URL='postgres://oci:...@postgres-rw.db:5432/oci' \
  --from-literal=REDIS_URL='redis://:...@redis.cache:6379' \
  --from-literal=AUTH_SECRET="$(openssl rand -base64 48)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -base64 48)" \
  --from-literal=METRICS_TOKEN="$(openssl rand -hex 24)" \
  --from-literal=INITIAL_ADMIN_EMAIL=admin@example.com

helm install oci oci://ghcr.io/ncecere/charts/open-chat-interface --version 0.11.0 -n oci \
  --set secrets.existingSecret=oci-runtime \
  --set config.appUrl=https://chat.example.com \
  --set web.trustedProxies='10.244.0.0/16' \
  --set ingress.enabled=true --set ingress.className=nginx \
  --set 'ingress.hosts[0].host=chat.example.com'
```

The chart is published to GHCR as an OCI artifact with every release from
v0.11 (chart `X.Y.Z` deploys images `vX.Y.Z`; `helm show values
oci://ghcr.io/ncecere/charts/open-chat-interface --version X.Y.Z`). From a
checkout, use the path `deploy/helm/open-chat-interface` instead.

Keep `AUTH_SECRET` and `ENCRYPTION_KEY` in your secret manager: losing
`ENCRYPTION_KEY` makes stored provider and connector credentials unreadable.
With `INITIAL_ADMIN_PASSWORD` unset, a one-time password is printed to the API
log on the first start (`kubectl -n oci logs deploy/oci-open-chat-interface-api`).

## Upgrade

```bash
# 1. Preflight (changes nothing): the target image against the database.
kubectl -n oci run oci-upgrade-check --rm -i --restart=Never \
  --image=ghcr.io/ncecere/open-chat-interface/api:vX.Y.Z \
  --overrides='{"spec":{"containers":[{"name":"oci-upgrade-check","image":"ghcr.io/ncecere/open-chat-interface/api:vX.Y.Z","command":["node","dist/scripts/upgrade-check.js"],"envFrom":[{"secretRef":{"name":"oci-runtime"}}]}]}}'
# 2. Upgrade: migrate -> rolling update -> migrate --post.
helm upgrade oci oci://ghcr.io/ncecere/charts/open-chat-interface --version X.Y.Z \
  -n oci --reuse-values --timeout 30m
```

`helm upgrade` runs the pre-upgrade hook `node dist/migrate.js` (fast,
transactional; the previous release keeps working on the new schema), then
replaces API, worker and web pods one at a time (each API pod drains), then
the post-upgrade hook `node dist/migrate.js --post`. Before `migrate --post`
the hook waits until both Deployments' rollouts have finished and no pod of
the previous release is still terminating, because post-deploy steps may drop
what the previous release reads. Helm waits for hooks at most `--timeout`
(default 5 minutes): give it the preflight's estimate for index builds. A
failed pre-upgrade hook stops the upgrade before any pod is replaced; a failed
post-upgrade hook marks the release failed with the new pods running, and
rerunning `helm upgrade` (or the job's command) resumes it.

## How draining is wired

On `SIGTERM` an API pod answers `503` on `/api/health/ready`, refuses new chat
turns with `503` (the web app retries them on another pod), and lets replies
in progress finish for `config.shutdownDrainTimeoutMs` (25 s), saving the rest
as interrupted. The chart:

- runs a `preStop` sleep (`api.preStopSleepSeconds`, 5 s) so the Service
  endpoints, kube-proxy and Caddy's 2-second DNS refresh stop sending new
  requests before the drain starts;
- probes readiness every 2 s with one failure (`/api/health/ready`), liveness
  on `/api/health/live` (which stays `200` while draining), and a startup
  probe so slow starts are not killed;
- sets `terminationGracePeriodSeconds` (40) above preStop + drain, and refuses
  to render values that do not;
- requires `maxUnavailable: 0` and adds PodDisruptionBudgets, so a replacement
  is ready before a pod drains and a node drain stops one pod at a time.

## Client addresses

OCI records a client address on sessions and in the audit log, and limits
sign-in attempts per address. Caddy in the web pods decides it: it trusts
`X-Forwarded-For` only from `web.trustedProxies` (your ingress controller's pod
range, space-separated) and passes the API exactly one address. The API
believes only that header. So:

- route **all** traffic, `/api` included, to the web Service; never expose the
  API Service through an Ingress;
- keep `networkPolicy.enabled` (the default): the API accepts connections only
  from the web pods (and metrics scrapers), so nothing else in the cluster can
  set the header;
- a `LoadBalancer` web Service sees the node's address unless
  `externalTrafficPolicy: Local` (or the PROXY protocol) preserves the client's.

## Security

Pods run as non-root (API image user `100:101`, Caddy as `65532`) with
read-only root filesystems, `seccompProfile: RuntimeDefault`, no privilege
escalation and all capabilities dropped; the chart passes the Pod Security
`restricted` profile (tested on kind). Writable paths are emptyDir volumes:
`/tmp` and the attachment directory for the API image, `/data`, `/config` and
`/tmp` for Caddy. Caddy listens on 8080, and from v0.11 the web image removes
the binary's `cap_net_bind_service` file capability, so the web container
drops every capability with nothing added. Web images before v0.11 still
carry it, and executing one fails (`operation not permitted`) unless
`containerSecurityContext.web.capabilities.add` is `[NET_BIND_SERVICE]`. No pod mounts a service account token;
the post-upgrade hook projects one into its `wait-for-rollout` init container
only, bound to a Role that can read the two Deployments and list Pods and
that exists only while the hook runs.

## Autoscaling

`api.autoscaling.enabled` scales on CPU (70 % of requests). To scale on OCI's
own metrics, expose them through a custom metrics adapter and add the metric
to `api.autoscaling.metrics`. With prometheus-adapter, a per-pod request rate:

```yaml
# prometheus-adapter rules
- seriesQuery: 'oci_http_requests_total{namespace!="",pod!=""}'
  resources: { overrides: { namespace: { resource: namespace }, pod: { resource: pod } } }
  name: { matches: oci_http_requests_total, as: oci_http_requests_per_second }
  metricsQuery: 'sum(rate(<<.Series>>{<<.LabelMatchers>>}[2m])) by (<<.GroupBy>>)'
```

```yaml
# values
api:
  autoscaling:
    enabled: true
    metrics:
      - type: Pods
        pods:
          metric: { name: oci_http_requests_per_second }
          target: { type: AverageValue, averageValue: "20" }
```

Replies are long-lived streams, so scale down slowly
(`api.autoscaling.behavior.scaleDown.stabilizationWindowSeconds: 600`); each
pod removed drains like any other. Workers scale by `worker.replicaCount`
(jobs run one at a time under locks; a second worker is for availability).

## Values

Every key is documented in [values.yaml](values.yaml) and checked by
[values.schema.json](values.schema.json).

### Images and secrets

| Key | Default | Description |
| --- | --- | --- |
| `image.api.repository` | `ghcr.io/ncecere/open-chat-interface/api` | API image (API, worker, migration jobs). linux/amd64 and linux/arm64. |
| `image.web.repository` | `ghcr.io/ncecere/open-chat-interface/web` | Web image. |
| `image.{api,web}.tag` | chart `appVersion` | Keep both on the same release. |
| `image.{api,web}.digest` | `""` | Optional `sha256:` pin. |
| `image.pullPolicy`, `image.pullSecrets` | `IfNotPresent`, `[]` | The GHCR images are public. |
| `secrets.existingSecret` | `""` | Secret whose keys become environment variables (envFrom): `DATABASE_URL`, `AUTH_SECRET`, `ENCRYPTION_KEY` (required), `REDIS_URL`, `METRICS_TOKEN`, `INITIAL_ADMIN_*`, `CONTROL_DATABASE_URL`, `READ_DATABASE_URL`, Redis Sentinel/Cluster passwords, SMTP or S3 values. |
| `secrets.values` | `{}` | Evaluation only: the chart renders a Secret from these (kept in the release). |

### Configuration

| Key | Default | Description |
| --- | --- | --- |
| `config.appUrl` | `""` (required) | Public URL people use. |
| `config.authTrustedOrigins` | `""` | Trusted internal OIDC/SAML origins, comma-separated. |
| `config.logLevel` | `info` | |
| `config.storageLocalPath` | `/data/storage` | Local attachment directory. |
| `config.shutdownDrainTimeoutMs` | `25000` | How long a stopping pod lets replies finish. |
| `config.migrationLockTimeoutMs`, `config.migrationStatementTimeoutMs`, `config.postMigrationStatementTimeoutMs` | `""` | Migration timeouts; empty uses the defaults (3 s, 15 min, 4 h). |
| `config.otelExporterOtlpEndpoint`, `config.otelServiceName` | `""` | OpenTelemetry traces. |
| `config.env` | `{}` | Any other plain variable (`CHAT_STREAM_TTL_SECONDS`, `DISPLAY_TIMEZONE`, ...). |
| `redis.sentinels`, `redis.clusterNodes` | `""` | `REDIS_SENTINELS`, `REDIS_CLUSTER_NODES` (v0.11 Redis high availability). |
| `extraEnv`, `extraEnvFrom` | `[]` | Extra EnvVar / envFrom entries for the API image's pods. |

### Migrations

| Key | Default | Description |
| --- | --- | --- |
| `migrations.enabled` | `true` | Hook jobs; pods run with `RUN_MIGRATIONS=false`. `false` lets a single API replica migrate itself. |
| `migrations.hookDeletePolicy` | `before-hook-creation` | Jobs are kept for their logs until the next upgrade. |
| `migrations.ttlSecondsAfterFinished` | `86400` | |
| `migrations.pre.activeDeadlineSeconds`, `.backoffLimit` | `1800`, `2` | `migrate`. |
| `migrations.post.enabled` | `true` | `migrate --post` after the rollout. |
| `migrations.post.activeDeadlineSeconds`, `.backoffLimit` | `21600`, `3` | Index builds can be long; reruns resume. |
| `migrations.post.waitForRollout` | `true` | Wait for every API and worker pod to run the new release first. With `false`, always use `helm upgrade --wait`. |
| `migrations.resources` | 100m / 256Mi, limit 1Gi | |

### API, worker and web

| Key | Default | Description |
| --- | --- | --- |
| `api.replicaCount` | `2` | |
| `api.strategy` | RollingUpdate, maxSurge 1, maxUnavailable 0 | `maxUnavailable` must be 0. |
| `api.terminationGracePeriodSeconds` | `40` | Must exceed drain + preStop. |
| `api.preStopSleepSeconds`, `api.preStopSleepAction` | `5`, `false` | `true` uses the native `sleep` action (Kubernetes 1.30+). |
| `api.resources` | 250m / 512Mi, limit 3Gi | Document exports need up to about 1.2 GB at peak. |
| `api.startupProbe`, `api.readinessProbe`, `api.livenessProbe` | health endpoints | Readiness every 2 s, one failure. |
| `api.podDisruptionBudget` | `maxUnavailable: 1` | |
| `api.autoscaling` | off; CPU 70 %, 2-10 | `metrics` for custom metrics, `behavior`. |
| `api.service` | ClusterIP, 3000 | |
| `worker.enabled` | `true` | Off: the API runs the jobs (`OCI_ROLE=all`). |
| `worker.replicaCount` | `1` | Two for availability. |
| `worker.terminationGracePeriodSeconds` | `40` | No preStop: nothing routes to it. |
| `worker.resources` | 100m / 512Mi, limit 3Gi | Backups and rendering need memory. |
| `web.replicaCount` | `2` | |
| `web.trustedProxies` | `""` | Space-separated IPs/CIDRs of the proxies in front (ingress controller pods). |
| `web.terminationGracePeriodSeconds`, `web.preStopSleepSeconds` | `40`, `5` | Replies stream through these pods. |
| `web.resources` | 25m / 64Mi, limit 256Mi | |
| `web.autoscaling`, `web.podDisruptionBudget`, `web.service` | off; `maxUnavailable: 1`; ClusterIP 8080 | |
| `{api,worker,web}.topologySpreadConstraints` | `[]` | Replaces the default spread (hostname and zone, best effort; `defaultTopologySpread`). |
| `{api,worker,web}.nodeSelector`, `.tolerations`, `.affinity`, `.priorityClassName`, `.podAnnotations`, `.podLabels` | empty | |
| `{api,worker}.extraVolumes`, `.extraVolumeMounts` | `[]` | |

### Security, storage, exposure, metrics

| Key | Default | Description |
| --- | --- | --- |
| `serviceAccount.create`, `.name`, `.annotations` | `true`, `""`, `{}` | No token is mounted. |
| `podSecurityContext.{api,web}`, `containerSecurityContext.{api,web}` | restricted | See Security above. |
| `tmpVolume.sizeLimit` | `1Gi` | `/tmp` of the API and worker (imports, backups). |
| `storage.persistence.enabled` | `false` | A PVC for local attachments (`ReadWriteMany` with several pods). Off: an emptyDir, so configure S3 under Admin → Data & storage → Storage. |
| `storage.persistence.existingClaim`, `.storageClass`, `.accessModes`, `.size` | `""`, `""`, `[ReadWriteMany]`, `20Gi` | The PVC is kept on uninstall. |
| `ingress.enabled`, `.className`, `.annotations`, `.hosts`, `.tls` | off | Routes to the web Service. Disable response buffering and raise read timeouts for streaming. |
| `httpRoute.enabled`, `.parentRefs`, `.hostnames`, `.ruleExtras` | off | Gateway API `HTTPRoute` to the web Service. |
| `networkPolicy.enabled` | `true` | Ingress rules: API from web pods and scrapers only; workers from scrapers only. |
| `networkPolicy.webFrom` | `[]` (everyone) | Restrict to the ingress controller. |
| `networkPolicy.metricsFrom` | namespace `monitoring` | Who may scrape port 3000. |
| `networkPolicy.egress.enabled`, `.extraEgress` | off | DNS plus your database, Redis, S3 and providers. |
| `metrics.serviceMonitor.enabled` | `false` | Prometheus Operator; needs `METRICS_TOKEN` in the Secret. |
| `metrics.serviceMonitor.tokenSecretKey`, `.interval`, `.scrapeTimeout`, `.labels` | `METRICS_TOKEN`, `30s`, `10s`, `{}` | |
| `metrics.prometheusRule.enabled`, `.labels` | `false`, `{}` | A `PrometheusRule` with the service objectives' recording rules, burn-rate and operational alerts (`files/prometheus-rules.yaml`, a copy of `deploy/monitoring/prometheus-rules.yaml`; docs/dev/slo.md). `labels` must match your Prometheus's rule selector. |
| `tests.enabled` | `true` | `helm test`: `/api/health/ready` through the web Service. |
| `clusterDomain` | `cluster.local` | For the API's DNS name. |

## Local test on kind

```bash
kind create cluster --name oci-helm
docker build -f docker/api.Dockerfile -t oci-helm-test/api:local .
docker build -f docker/web.Dockerfile -t oci-helm-test/web:local .
docker tag oci-helm-test/api:local oci-helm-test/api:local2
docker tag oci-helm-test/web:local oci-helm-test/web:local2
kind load docker-image --name oci-helm oci-helm-test/api:local oci-helm-test/api:local2 \
  oci-helm-test/web:local oci-helm-test/web:local2
deploy/helm/dev/kind-test.sh
kind delete cluster --name oci-helm
```

The script installs with single-pod PostgreSQL and Redis
([dev/dependencies.yaml](../dev/dependencies.yaml), test only), checks the
hooks, readiness through the web Service, `helm test` and the network policy,
then upgrades to a new tag under load and requires no failed request. CI runs
it on linux/amd64 and linux/arm64 (`.github/workflows/helm.yml`).
