# Service objectives and alerts

OCI's published service objectives (v0.11 design, item 24), how each is
measured from the metrics the API exports, the alerts that guard them, and
what they leave out. The files:

- [`deploy/monitoring/prometheus-rules.yaml`](../../deploy/monitoring/prometheus-rules.yaml):
  recording rules for each objective, burn-rate alerts and operational
  alerts, as a plain Prometheus rule file. The Helm chart renders the same
  rules as a `PrometheusRule` (`metrics.prometheusRule.enabled`).
- [`deploy/monitoring/prometheus-rules.test.yaml`](../../deploy/monitoring/prometheus-rules.test.yaml):
  `promtool` unit tests for them.
- [`deploy/monitoring/grafana-dashboard.json`](../../deploy/monitoring/grafana-dashboard.json):
  a dashboard of the objectives and the operational signals.

Metrics are served at `/metrics` on every API and worker replica when
`METRICS_TOKEN` is set ([Observability](../admin/observability.md#metrics)).
Every replica must be scraped: values are per process.

## Objectives

Measured over a rolling 30 days, per OCI instance.

| Objective | Target | Error budget (30 days) | Measured from |
| --- | --- | --- | --- |
| [Availability](#availability) | 99.9 % of API requests succeed | 0.1 % of requests (about 43 minutes of total outage) | `oci_http_requests_total` |
| [Reply start added by OCI](#reply-start-added-by-oci) | p95 under 1 s | 5 % of replies may take longer | `oci_chat_reply_start_seconds` |
| [Sidebar and conversation opening](#sidebar-and-conversation-opening) | p95 under 300 ms | 5 % of requests may take longer | `oci_http_request_duration_seconds` |
| [Search](#search) | p95 under 1 s | 5 % of searches may take longer | `oci_http_request_duration_seconds` |

The latency targets are the design's proposals, which the
[scale harness](scale-harness.md#baseline) measured on a shared laptop at
`small` and `medium` (p95: sidebar 10 and 68 ms, opening a conversation 5 and
42 ms, reply start 142 and 400 ms, search 79 and 718 ms). `large` has not been
measured on dedicated hardware yet, so the targets are not yet shown to hold
there. A latency objective with a p95 target is the same as "95 % of events
under the threshold", which is how it is measured: the share of events in the
histogram bucket at the threshold, exact because the buckets include 0.3 s and
1 s.

### Availability

- **Counted**: every request the API routes, by its status when the response
  starts. **Bad**: status 500 to 599. **Good**: everything else, including
  4xx (a refused, invalid or rate-limited request is the service working as
  designed).
- **Not counted**: `/api/health/*` (probes; a replica that is not ready
  spends no budget for saying so), `/metrics`, and requests that matched no
  route (`route="unmatched"`).
- **Draining**: a replica shutting down refuses new chat turns with `503`,
  `Retry-After: 1` and `X-OCI-Draining: 1` before routing them, so they never
  reach the metrics; the web app (and the bundled proxy's retry) sends them
  again to another replica. They spend no budget. Any other `503` counts.
- **Retryable 500s** (a lost database connection during a failover,
  `X-OCI-Retryable: database-connection`) count as bad: the person may have
  seen an error. A failover is meant to spend a little budget.
- **A reply that fails after it started streaming** answered `200` and is not
  an availability error; its outcome is `oci_chat_replies_total{status}`
  (usually the model provider's failure, alerted on separately).

```promql
# Error ratio over 30 days (budget: 0.001)
sum(increase(oci_http_requests_total{route!~"/api/health/.*|/metrics|unmatched", status=~"5.."}[30d]))
  / sum(increase(oci_http_requests_total{route!~"/api/health/.*|/metrics|unmatched"}[30d]))

# Budget left (1 = untouched, 0 = spent)
1 - (that ratio) / 0.001
```

### Reply start added by OCI

`oci_chat_reply_start_seconds`: from the moment a turn's request reaches the
API (`POST /api/chat`, or continuing after tool approvals) to the moment OCI
sends the model its first request, **less any wait for provider capacity**.
It covers everything OCI does first: authentication, rate limits, the quota
reservation, storing the turn, loading the conversation and building the
context, project retrieval (with the query embedding) and web search
grounding when the turn uses it.

Not included, and exported on its own:

| Part of the wait a person sees | Metric |
| --- | --- |
| Waiting for provider capacity (administrator-set limits) | `oci_provider_queue_wait_seconds{provider, model}` |
| The provider's time to first output, retries after 429 or overload included | `oci_provider_first_output_seconds{provider, model}` |
| The network, proxies and the browser | not measured by OCI |

The scale harness measures the same span from the client (k6 sends, the stub
model records arrival), which adds the proxy and network, so its numbers run
slightly higher than this metric.

```promql
histogram_quantile(0.95, sum by (le) (rate(oci_chat_reply_start_seconds_bucket[5m])))

# Share within 1 s over 30 days (target 0.95); Prometheus 3 stores le="1" as "1.0"
sum(increase(oci_chat_reply_start_seconds_bucket{le=~"1(\\.0)?"}[30d]))
  / sum(increase(oci_chat_reply_start_seconds_count[30d]))
```

### Sidebar and conversation opening

`oci_http_request_duration_seconds` (time until the response starts) for
`GET` on the sidebar's requests, `/api/me`, `/api/threads`, `/api/models` and
`/api/projects/sidebar`, and on opening a conversation,
`/api/chat/:threadId/messages`. Each request is an event. The browser sends
the sidebar's requests in parallel, so the sidebar appears when the slowest
one answers (the harness's `sidebar_ms`); 95 % of each under 300 ms keeps that
close. If a release adds a route to either (for example a paged conversation
read), add it to the `route=~` lists in the rules and the dashboard.

```promql
histogram_quantile(0.95, sum by (le, route) (rate(oci_http_request_duration_seconds_bucket{method="GET", route=~"/api/me|/api/threads|/api/models|/api/projects/sidebar|/api/chat/:threadId/messages"}[5m])))
```

### Search

`GET /api/threads/search` (conversation search), each request an event,
threshold 1 s. Before v0.11 the route was labelled `/api/threads/:id` (the
label took the last matching route, not the handler that answered), so search
could not be told apart; it is fixed.

```promql
histogram_quantile(0.95, sum by (le) (rate(oci_http_request_duration_seconds_bucket{method="GET", route="/api/threads/search"}[5m])))
```

### Out of scope

- **The model provider's latency and errors.** OCI cannot make a provider
  faster; it exports the provider's time to first output, its throttling and
  failed replies, and alerts on them as operational signals, not objectives.
- The network, any proxy or load balancer in front of OCI, and time spent in
  the browser.
- Administrative reports, exports, imports, uploads and background work
  (embeddings, summaries, retention, backups): covered by operational alerts
  on queues and failures rather than by a latency objective.
- Reply duration: it depends on the model and the length of the answer.

## Alerts

All in [`prometheus-rules.yaml`](../../deploy/monitoring/prometheus-rules.yaml).
`critical` should page someone; `warning` should open a ticket. Thresholds of
the operational alerts are starting points.

### Burn-rate alerts

Multi-window, multi-burn-rate alerts (as in Google's SRE workbook, "Alerting
on SLOs") for each objective. The burn rate is how many times faster than
sustainable the budget is being spent: 1 spends 30 days' budget in 30 days.

| Alert | Fires when | Severity |
| --- | --- | --- |
| `Oci<Objective>BudgetFastBurn` | burn rate above 14.4 over 1 h and over 5 min (2 % of the monthly budget in an hour) | critical |
| `Oci<Objective>BudgetSlowBurn` | burn rate above 6 over 6 h and over 30 min (5 % in six hours) | warning |

`<Objective>` is `Availability`, `ReplyStart`, `Browse` or `Search`. The short
window makes an alert stop soon after the problem does. Each needs 20 events
in the long window, so one slow search on a quiet instance pages nobody. The
recording rules `oci_slo:<objective>:ratio_rate{5m,30m,1h,6h}` hold the bad
share per `namespace` and `job`.

### Database

| Alert | Meaning | First steps |
| --- | --- | --- |
| `OciDatabasePoolSaturated` | A replica has more than 90 % of `DATABASE_POOL_MAX` busy (`active` or `idle in transaction`) for 10 min | Add API replicas, or raise `DATABASE_POOL_MAX` within the server's `max_connections`; look for slow queries (`pg_stat_statements`) |
| `OciDatabaseSlowToAnswer` | `select 1` through the pool takes over 250 ms on average for 10 min: requests queue for a connection, or the server is overloaded | As above; check the server's CPU and I/O |
| `OciDatabaseReplicationLag` | A standby is more than 30 s behind for 10 min | A failover now would lose that much. Check the standby's I/O and network |

`oci_database_connections{state}` counts this replica's connections from
`pg_stat_activity` by its `application_name` (`oci:<role>:<id>@<host>`),
control connections (job locks, `LISTEN`) included, and needs no extra
privilege. `oci_database_replication_lag_seconds` reads
`pg_stat_replication` on the primary, which shows lag only to a role with
`pg_monitor` (as background migrations' throttle needs); without it the gauge
is absent and the alert silent. Behind **PgBouncer** in transaction mode,
`pg_stat_activity` shows PgBouncer's server connections: watch
`pgbouncer_exporter`'s `pgbouncer_pools_client_waiting_connections` instead,
while `oci_database_probe_seconds` still shows the wait. For the database
server itself use
[postgres_exporter](https://github.com/prometheus-community/postgres_exporter):

```yaml
# Replication lag on each standby (postgres_exporter, default collectors)
- alert: PostgresReplicationLag
  expr: pg_replication_lag_seconds > 30   # pg_replication_lag in older versions
  for: 10m
# Connections against the server's limit
- alert: PostgresConnectionsNearLimit
  expr: sum by (instance) (pg_stat_activity_count) / max by (instance) (pg_settings_max_connections) > 0.9
  for: 10m
```

### Background work

| Alert | Meaning | First steps |
| --- | --- | --- |
| `OciNoBackgroundWorker` (critical) | No `worker` or `all` replica has checked in for 5 min | Start one (`OCI_ROLE=worker`); see [Process roles](../OPERATIONS.md#process-roles) |
| `OciBackgroundJobsNotRunning` (critical) | The 15-second sweep has not run for 10 min | Workers are up but their job runner is stuck: check their logs, restart them |
| `OciBackgroundJobFailing` | A job failed 3 times in 30 min without succeeding | Its error is on **System health** |
| `OciQueueBacklog` | Over 20 imports or 200 summaries waiting for 30 min | Workers are missing, failing or too few |
| `OciWebhookBacklog`, `OciStorageDeletionBacklog` | Deliveries or deletions piling up | An endpoint or storage credentials are failing |
| `OciBackgroundMigrationFailed` | A background migration stopped after five failures | Fix the cause, resume it on **System health → Background migrations** |
| `OciBackgroundMigrationStalled` | A running background migration processed nothing for an hour | Throttled (replication lag, a long transaction: System health says) or no worker |
| `OciBackupStale` | No successful backup for 26 h | See the backup's error on **System health** |

OCI's job metrics have a label `job` (the job's name), which Prometheus
stores as `exported_job` because `job` is its own target label (with the
default `honor_labels: false`). The rules use `exported_job`.

### Usage and quota

| Alert | Meaning |
| --- | --- |
| `OciUsageRollupBacklog` | Over 50,000 usage changes wait to be folded into the hourly rollups for 15 min. Usage pages and budget checks stay exact (they add the unfolded changes) but read more each time. |
| `OciUsageRollupFoldStale` | `usage.fold-rollups` (every 30 s on workers) has not succeeded for 15 min. |

### Model providers

Signals about the providers, outside OCI's objectives.

| Alert | Meaning |
| --- | --- |
| `OciReplyErrors` | Over 5 % of replies failed in 15 min, usually the provider's errors |
| `OciProviderThrottling` | A provider answers 429 more than once every 10 s: set or lower its limits under **Providers & Models** so turns queue instead |
| `OciProviderSlowFirstOutput` | A model's p95 time to first output is over 15 s |
| `OciProviderQueueWaits` | Turns wait over 30 s (p95) for provider capacity |
| `OciProviderQueueTimeouts` | Turns gave up waiting for capacity ("*model* is busy") |

### Redis, readiness and draining

| Alert | Meaning |
| --- | --- |
| `OciRedisUnavailable` (critical) | No replica reaches Redis: replies are not resumable, limits count per replica ([When Redis is unavailable](../OPERATIONS.md#when-redis-is-unavailable)) |
| `OciRedisUnavailableOnReplica` | One replica cannot reach Redis while others can |
| `OciReadinessFlapping` | A replica failed readiness more than once in 30 min (draining excluded): its database was unreachable for over 30 s each time |
| `OciRepliesInterruptedByDrain` | Replies were still running when their replica's drain limit ran out and were saved as interrupted. Raise `SHUTDOWN_DRAIN_TIMEOUT_MS` and the termination grace period together ([Shutting down and draining](../OPERATIONS.md#shutting-down-and-draining)) |

The replica that interrupts a reply exits seconds later, usually before
Prometheus scrapes it again, so the count is also kept in Redis and exported
by every replica as `oci_cluster_drain_interrupted_replies_total` (aggregate
with `max`); `oci_drain_interrupted_replies_total` is the per-process count.

## Metrics added for the objectives

New in v0.11 (labels in [Observability](../admin/observability.md#metrics)):

| Metric | Type | What |
| --- | --- | --- |
| `oci_chat_reply_start_seconds` | histogram | Reply start added by OCI |
| `oci_provider_first_output_seconds` | histogram | `provider`, `model`: the provider's time to first output |
| `oci_drain_interrupted_replies_total` | counter | Replies this process saved as interrupted at its drain limit |
| `oci_cluster_drain_interrupted_replies_total` | counter | The same across replicas, kept in Redis |
| `oci_readiness_transitions_total` | counter | `to`: `ready`, `not_ready` |
| `oci_job_last_success_timestamp_seconds` | gauge | `job`: last success on this process |
| `oci_database_connections` | gauge | `state`: this replica's connections |
| `oci_database_pool_max` | gauge | `DATABASE_POOL_MAX` |
| `oci_database_probe_seconds` | gauge | `select 1` through the pool at scrape time |
| `oci_database_replication_lag_seconds` | gauge | Largest standby lag (needs `pg_monitor`) |
| `oci_queue_depth` | gauge | `queue`: `conversation_imports`, `compaction`, `usage_rollup_changes` (counted up to 100,000) |
| `oci_redis_up` | gauge | 1 or 0; absent without Redis |
| `oci_background_workers_alive` | gauge | 1 when some replica runs background jobs |
| `oci_replicas` | gauge | `role`: replicas heard from in Redis |
| `oci_process_role` | gauge | `role` of this process |
| `oci_draining` | gauge | 1 while this process drains |

`oci_http_request_duration_seconds` gained a 0.3 s bucket, and its `route`
label now names the handler that answered (`/api/threads/search`, not
`/api/threads/:id`).

## Setting it up

**Prometheus** (Compose or VMs): scrape every API and worker replica
([Observability](../admin/observability.md#metrics)) and load the rules:

```yaml
rule_files:
  - /etc/prometheus/oci/prometheus-rules.yaml   # deploy/monitoring/prometheus-rules.yaml
```

**Kubernetes with the Prometheus Operator**: with the chart, set
`metrics.serviceMonitor.enabled=true`, `metrics.prometheusRule.enabled=true`
and the labels your Prometheus selects rules and monitors by (for example
`metrics.prometheusRule.labels.release=kube-prometheus-stack`). Enable the
rules in one release per Prometheus: they group by namespace, and Alertmanager
merges identical alerts from a second copy anyway.

**Grafana**: import `deploy/monitoring/grafana-dashboard.json` (Dashboards →
New → Import) and choose the Prometheus data source; it has no data source ID
of its own. The burn-rate panel needs the recording rules.

**Checking the rules** after changing them:

```bash
docker run --rm -v "$PWD/deploy/monitoring:/rules:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 check rules /rules/prometheus-rules.yaml
docker run --rm -v "$PWD/deploy/monitoring:/rules:ro" --entrypoint promtool \
  prom/prometheus:v3.15.0 test rules /rules/prometheus-rules.test.yaml
cp deploy/monitoring/prometheus-rules.yaml deploy/helm/open-chat-interface/files/
```

`.github/workflows/helm.yml` runs both with Prometheus 2 and 3 and fails when
the chart's copy differs.
