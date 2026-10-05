# Observability and events

Three ways to watch an OCI instance from outside it:

- **[Metrics](#metrics)**: a Prometheus endpoint, off unless a scrape token is
  set.
- **[Traces](#traces)**: OpenTelemetry over OTLP, off unless a collector is
  configured.
- **[Webhooks](#webhooks)**: selected audit events posted to your own HTTPS
  endpoints, signed and retried.

Metrics and traces are configured with environment variables on the API and
shown, read-only, on **Data & storage → System health** under *Observability*.
Webhooks are managed under **Tools & integrations → Webhooks**.

None of them carries conversation content: no prompts, replies, tool inputs or
results, file names or request bodies.

## Metrics

Set `METRICS_TOKEN` (at least 16 characters, for example from
`openssl rand -hex 24`) and restart the API. It then serves Prometheus text
format at `/metrics` on the API port, requiring the token as a Bearer
credential. Without the variable, `/metrics` answers 404.

`/metrics` is at the API's root, not under `/api`, so the bundled web proxy
(Caddy) does not forward it: scrape each API replica directly on its own
address, from inside your network. Values are per process; Prometheus adds them
up across replicas.

```yaml
scrape_configs:
  - job_name: oci-api
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/oci-metrics-token
    static_configs:
      - targets: ['api-1:3000', 'api-2:3000']
```

| Metric | Type | Labels |
| --- | --- | --- |
| `oci_http_requests_total` | counter | `method`, `route` (the template of the route that answered, such as `/api/threads/:id` or `/api/threads/search`; `unmatched` when no route matched), `status` |
| `oci_http_request_duration_seconds` | histogram | `method`, `route` (time until the response starts; a streamed reply is timed separately) |
| `oci_chat_reply_start_seconds` | histogram | Time OCI adds before a reply: from the request arriving to the first model request, less any wait for provider capacity |
| `oci_provider_first_output_seconds` | histogram | `provider`, `model`: from a reply's first model request to its first output, retries included |
| `oci_chat_replies_total` | counter | `status`: `complete`, `error`, `cancelled` |
| `oci_chat_reply_duration_seconds` | histogram | `status` |
| `oci_tool_calls_total` | counter | `tool` (the tool id, such as `web_search` or `mcp__docs__search`), `outcome`: `ok`, `error`, `denied`, `refused` |
| `oci_tool_call_duration_seconds` | histogram | `tool` |
| `oci_job_runs_total` | counter | `job`, `outcome`: `success`, `error` |
| `oci_job_duration_seconds` | histogram | `job` |
| `oci_job_last_success_timestamp_seconds` | gauge | `job`: when it last succeeded on this process |
| `oci_web_searches_total` | counter | `provider` (such as `searxng`, `brave`), `slot`: `primary`, `fallback`; `outcome`: `answered`, `failed`. Searches from conversations only, never the query |
| `oci_web_search_duration_seconds` | histogram | `provider`, `slot` (retry included) |
| `oci_webhook_deliveries_total` | counter | `outcome`: `succeeded`, `retrying`, `failed` |
| `oci_webhook_deliveries_pending` | gauge | Deliveries waiting for a first attempt or a retry |
| `oci_storage_deletions_pending` | gauge | Stored objects queued for deletion |
| `oci_backup_runs_total` | counter | `outcome`: `succeeded`, `failed` |
| `oci_backup_duration_seconds` | histogram | |
| `oci_backup_last_success_timestamp_seconds` | gauge | Absent until a backup succeeds |
| `oci_provider_queue_waits_total` | counter | `provider` (its display name), `model` (its slug), `outcome`: `admitted`, `timeout`, `cancelled`, `handoff`. Messages that waited for [provider capacity](models-providers.md#provider-capacity) |
| `oci_provider_queue_wait_seconds` | histogram | `provider`, `model` |
| `oci_provider_queue_waiting` | gauge | Messages waiting on this replica now |
| `oci_provider_throttled_total` | counter | `provider`, `model`, `status`: the provider's `429`, `408`, `409`, `5xx`, or `529` for an overload reported in the stream |
| `oci_provider_retries_total` | counter | `provider`, `model`: requests sent again before the reply's first output |
| `oci_errors_total` | counter | `source`: unexpected server errors |
| `oci_readiness_transitions_total` | counter | `to`: `ready`, `not_ready`. Changes of `/api/health/ready`, draining excluded |
| `oci_drain_interrupted_replies_total` | counter | Replies this process saved as interrupted when its drain limit ran out |
| `oci_cluster_drain_interrupted_replies_total` | counter | The same for every replica, kept in Redis (each replica reports the total: use `max`); absent without Redis |
| `oci_draining` | gauge | 1 while this process drains |
| `oci_process_role` | gauge | `role`: `web`, `worker`, `all` |
| `oci_database_connections` | gauge | `state`: this replica's connections to the primary, from `pg_stat_activity` |
| `oci_database_pool_max` | gauge | `DATABASE_POOL_MAX` |
| `oci_database_probe_seconds` | gauge | How long `select 1` through the pool took at scrape time |
| `oci_database_replication_lag_seconds` | gauge | Largest standby lag; absent without standbys or the `pg_monitor` role |
| `oci_queue_depth` | gauge | `queue`: `conversation_imports`, `compaction`, `usage_rollup_changes` (counted up to 100,000) |
| `oci_redis_up` | gauge | 1 or 0; absent when Redis is not configured |
| `oci_background_workers_alive` | gauge | 1 when some replica runs background jobs |
| `oci_replicas` | gauge | `role`: replicas heard from in Redis in the last minute |
| `oci_build_info` | gauge | `version` |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `process_uptime_seconds` | gauge | |

Labels never hold user ids, thread ids or raw paths, so the number of series
stays bounded. The gauges read from the database at scrape time; if the
database does not answer, they are left out of that scrape rather than failing
it.

Prometheus stores the `job` label of `oci_job_*` metrics as `exported_job`,
because `job` is its own target label (unless `honor_labels: true`).

[Service objectives and alerts](../dev/slo.md) defines OCI's objectives on
these metrics and ships a complete rule file and Grafana dashboard
(`deploy/monitoring/`). A few alerts on their own:

```yaml
- alert: OciBackupStale
  expr: time() - max(oci_backup_last_success_timestamp_seconds) > 26 * 3600
- alert: OciNoBackgroundWorker
  expr: max(oci_background_workers_alive) == 0
- alert: OciReplyErrors
  expr: sum(rate(oci_chat_replies_total{status="error"}[15m])) / sum(rate(oci_chat_replies_total[15m])) > 0.05
- alert: OciWebhookBacklog
  expr: max(oci_webhook_deliveries_pending) > 100
- alert: OciProviderThrottling
  # The provider refuses requests: set or lower its limits under Providers & Models.
  expr: sum by (provider) (rate(oci_provider_throttled_total{status="429"}[15m])) > 0.1
- alert: OciProviderQueueTimeouts
  # Messages give up waiting for a busy model.
  expr: sum by (provider) (increase(oci_provider_queue_waits_total{outcome="timeout"}[15m])) > 0
```

## Traces

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to your collector's OTLP/HTTP base URL (for
example `http://otel-collector:4318`; OCI appends `/v1/traces`) and restart the
API. `OTEL_SERVICE_NAME` sets the service name (default `oci-api`). Without the
endpoint, the OpenTelemetry SDK is not even loaded.

| Span | Attributes |
| --- | --- |
| `GET /api/threads/:id` (one per request, named by route template) | `http.request.method`, `http.route`, `http.response.status_code` |
| `chat.reply` | `oci.reply.status` |
| `tool.call` | `oci.tool.id`, `oci.tool.outcome` |
| `job <name>` | `oci.job.name`, `oci.job.items` |
| `backup.run` | `oci.backup.trigger` |
| `webhook.deliver` | `oci.webhook.event`, `http.response.status_code` |

An incoming W3C `traceparent` header is honoured, so a request joins the
caller's trace. Failed spans have an error status with a short description
(`HTTP 500`, an error class name), never an error message, which could quote
content. Outgoing calls to model providers and the database are not
instrumented.

Spans are batched and exported in the background; a collector that is down
loses spans, never requests.

## Webhooks

**Tools & integrations → Webhooks** (`/admin/webhooks`). A webhook endpoint
receives the [audit events](audit-reporting.md) you select, as they are
recorded: for example `user.*` to follow account changes, or `backup.run` to
alert on a failed backup.

### Adding an endpoint

Choose **Add endpoint** and enter:

- **URL**: an `https://` address. OCI does not follow redirects.
- **Audit actions**: one per line. `user.create` matches exactly; `user.*`
  matches every action that starts with `user.`. Or turn on **Send every audit
  event** (this includes `tool.call`, one per tool call, which can be a lot).
- **Allow private network**: like [connectors](connectors.md#private-networks),
  endpoints must be public HTTPS addresses unless this is on; it allows plain
  `http://` and private, loopback and link-local addresses. Cloud metadata
  addresses are always refused.

Saving shows the endpoint's **signing secret once**. Copy it into the receiver;
OCI stores it encrypted and never shows it again. **Rotate secret** replaces it
and shows the new one once; from then on every request, including retries of
earlier events, is signed with the new secret.

**Send test** posts a signed `webhook.test` event straight away and shows what
the endpoint answered. **Show deliveries** lists the last 50 deliveries with
their status, attempts and last error. Auditors can see endpoints and their
deliveries but not change them, send tests or see secrets.

Creating, changing, rotating and deleting endpoints are audited as
`webhook.create`, `webhook.update`, `webhook.rotate` and `webhook.delete`, and
are kept regardless of audit-log retention.

### What is sent

A `POST` with a JSON body:

```json
{
  "id": "6f0c1d2e-…",
  "type": "user.role.change",
  "createdAt": "2026-10-02T09:14:03.120Z",
  "actor": { "id": "u_123", "email": "admin@example.com" },
  "target": { "type": "user", "id": "u_456" },
  "metadata": { "from": "user", "to": "auditor" }
}
```

`id` is the audit entry's id, the same on every retry; deduplicate on it.
`metadata` is exactly what the audit log shows for the entry. The IP address is
left out. Headers:

| Header | Value |
| --- | --- |
| `OCI-Webhook-Id` | The delivery's id |
| `OCI-Webhook-Event` | The audit action, such as `user.role.change` |
| `OCI-Webhook-Timestamp` | Unix seconds when this attempt was signed |
| `OCI-Webhook-Signature` | `v1=` and the hex HMAC-SHA256 of `<timestamp>.<body>` with the endpoint's secret |

### Verifying a request

Compute the HMAC-SHA256 of the timestamp header, a full stop, and the raw
request body (the exact bytes, before parsing), keyed with the secret
(including its `whsec_` prefix), and compare it with the signature in constant
time. Reject requests whose timestamp is more than five minutes from your
clock, which stops replays.

Node.js:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyOciWebhook(secret, headers, rawBody) {
  const timestamp = headers['oci-webhook-timestamp'];
  const signature = headers['oci-webhook-signature'] ?? '';
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(
    `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`,
  );
  return signature
    .split(',')
    .map((value) => Buffer.from(value.trim()))
    .some((value) => value.length === expected.length && timingSafeEqual(value, expected));
}
```

Python:

```python
import hashlib, hmac, time

def verify_oci_webhook(secret: str, headers, raw_body: bytes) -> bool:
    timestamp = headers["OCI-Webhook-Timestamp"]
    if abs(time.time() - int(timestamp)) > 300:
        return False
    digest = hmac.new(secret.encode(), timestamp.encode() + b"." + raw_body, hashlib.sha256)
    expected = "v1=" + digest.hexdigest()
    return any(hmac.compare_digest(expected, part.strip())
               for part in headers["OCI-Webhook-Signature"].split(","))
```

Answer with any `2xx` status within ten seconds; the response body is ignored.

### Delivery and retries

Events are queued in the database when the audit entry is written and sent by
the `webhooks.deliver` background job, which starts within a second of an event
and runs every minute for retries. Delivery is at least once.

| Outcome | What happens |
| --- | --- |
| `2xx` | Delivered. |
| Any other status, a timeout (10 s) or a connection error | Retried after 1, 2, 4, 8, 16, 32 and 60 minutes; after 8 attempts the delivery is marked failed. |
| Refused address, scheme or redirect | Failed at once: retrying cannot help. Fix the URL or *Allow private network*. |
| Endpoint disabled or deleted | Pending deliveries are dropped (disabled: marked failed). |

The endpoint's last failure shows on its card and in the *Webhooks* row of
**System health**, which also warns when deliveries are more than 15 minutes
overdue (background jobs not running). Finished deliveries are kept for 30
days.
