# Operations

Day-to-day running. For deployment and upgrades, see
[Operations](../OPERATIONS.md).

## Health

![Health](../images/admin-health.png)

Whether the parts the instance depends on are working. Open this first when
something is reported.

| Check | Warns when | Fails when |
| --- | --- | --- |
| Database | Slow to respond | Not reachable |
| Redis | Not configured | Configured but unreachable |
| Model providers | — | None enabled |
| Models | — | None enabled |
| Background jobs | Failures in the last day | One started over an hour ago and never finished |
| Email delivery | Not configured | — |
| Attachment storage | Uploads never attached to a message | — |

The summary takes the worst individual result, so a green banner above a failing
row cannot happen.

**Redis absent is a warning, not an error.** A single-replica deployment without
it is supported; rate limits and streams simply become per-process. Across
several replicas it matters, and the warning is telling you so.

Each of these previously surfaced as a user complaint. "Nobody can send a
message" is a page of red here, not a mystery.

## Storage

![Storage](../images/admin-storage.png)

Where attachments live — a local path or an S3-compatible bucket — and what is
currently held.

**Test** checks the configuration actually works. Do this after any change; a
misconfigured bucket looks fine until somebody uploads a file.

**Reconcile** compares the database against what is really stored, and reports
disagreement. Worth running after restoring a backup, when the two can drift.

The local path is shown but not editable: it has to exist inside the container,
so it stays deployment-managed. It is shown at all so you know which volume to
back up.

## Search

![Search](../images/admin-search.png)

The provider used for web search grounding, and its key. Turning search off here
removes it from the composer entirely.

## Maintenance

![Maintenance](../images/admin-maintenance.png)

The background jobs, and a way to run one now.

Jobs run on their own schedule. Running one by hand is for after you have
changed a setting it depends on and would rather not wait — retention, say, or
storage reconciliation.

In a multi-replica deployment each job holds a lock, so it runs once regardless
of how many replicas are up.

## When somebody reports a problem

1. **Health** — is something actually broken?
2. **The audit log**, filtered to their address — what did they do, and what
   happened?
3. **Their user detail** — are they at a limit? Do their sessions look right?
4. **Usage** — has something changed instance-wide, or is it only them?

That order goes from cheapest to most specific, and answers most reports before
step four.
