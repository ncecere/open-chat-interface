# Compliance export and legal hold

**Data & storage → Compliance** (`/admin/compliance`). Two tools for
eDiscovery, records requests and security monitoring:

- **Compliance export**: every audit event and, if you turn it on, conversation
  content, written as [JSON Lines](https://jsonlines.org/) to S3-compatible
  storage every hour or every day. Each run continues exactly where the last
  one ended.
- **Legal hold**: named people whose data retention, trash purging, temporary
  chat expiry and account deletion must leave alone until the hold is lifted.

An `auditor` sees everything on the page and changes nothing.

## The export

### What is exported

| Stream | When | Each line |
| --- | --- | --- |
| Audit events | Always, while the export is on | One audit log entry: `seq`, `id`, `createdAt`, `action`, `actorUserId`, `actorEmail`, `targetType`, `targetId`, `metadata`, `ipAddress`. |
| Conversation content | Only with **Include conversation content** on | One message: `seq`, `id`, `threadId`, `userId`, `userEmail`, `role`, `status`, `model`, `parentMessageId`, `createdAt`, `updatedAt`, `supersededAt`, `error`, `thread` (`title`, `temporary`, `projectId`), `text`, `toolSteps`, `files`, `sources`. |

The first export includes the whole audit log as it stands (whatever audit
retention has kept). Audit entries written before v0.9 are numbered once, in
time order, by the upgrade.

For messages:

- `text` is the text people read. Model reasoning is not exported.
- `toolSteps` has one entry per tool call: the tool, its state and a one-line
  summary such as *Searched the web for "opening hours" · 5 results*. Raw tool
  results, which can hold whole fetched pages, are not exported.
- `files` names attached files (`attachmentId`, `filename`, `mediaType`).
  **Attachment contents are never exported**; they stay in attachment storage
  and in [backups](backups.md).
- `sources` lists cited URLs.
- A message is exported when it is created and again whenever its text, tool
  steps, status or error change, or a retry replaces it (`supersededAt`). A
  reply still being written is exported once, when it finishes. If a message
  changes several times between two runs, the export has its latest state.
- Temporary chats are included, marked `"temporary": true`.
- Deletions are not exported as messages. Deleting an account or a
  conversation from the trash leaves the lines already exported; account
  deletion and other administrative actions appear in the audit stream.

### Content is off by default

**Include conversation content** copies everyone's messages to the
destination, where OCI's retention, deletion and access controls no longer
apply. The page warns before you save it. Turn it on only where your policy
requires it, and say so in your [acceptable use policy](governance.md#acceptable-use).

Content is exported **from the moment you save the setting**: messages written
earlier are not exported, and turning it off and on again does not export what
was written while it was off. For one person's history, use their own data
export.

### Objects and manifest

Each run that has something to export writes one folder:

```text
<prefix>YYYY/MM/DD/<start time>-<run id>/
  audit.jsonl       audit events, in sequence order
  messages.jsonl    messages, in change order (only with content on)
  manifest.json     written last
```

`<prefix>` is `.oci-compliance/` in the attachment bucket, or your own prefix in
a separate bucket. A run with nothing new writes no folder; it still appears in
the history as *Nothing new to export*.

`manifest.json`:

```json
{
  "format": "oci-compliance/1",
  "ociVersion": "0.9.0",
  "runId": "…",
  "trigger": "schedule",
  "createdAt": "2026-10-02T02:00:04.120Z",
  "contentIncluded": false,
  "streams": {
    "audit": {
      "key": ".oci-compliance/2026/10/02/…/audit.jsonl",
      "afterSeq": 400,
      "throughSeq": 412,
      "count": 12,
      "firstSeq": 401,
      "lastSeq": 412,
      "firstId": "…",
      "lastId": "…",
      "bytes": 5120,
      "sha256": "…"
    },
    "messages": null
  }
}
```

A stream's object holds every line with a sequence number above `afterSeq` and
at or below `throughSeq`. `key` is null when the stream had nothing in that
range; `messages` is null when content is off. Sequence numbers can skip (a
rolled-back transaction uses a number and writes nothing), so continuity is
`afterSeq` of one manifest equalling `throughSeq` of the previous one, not
consecutive `seq` values.

### Exactly once

Every audit event appears in exactly one object, and so does every message
change:

- Each stream has a cursor, the last exported sequence number. A run reads a
  safe upper bound, writes everything between the cursor and that bound, reads
  every object back to check its size, SHA-256 and line count, writes the
  manifest, checks it too, and only then moves the cursor, in the same database
  transaction that marks the run succeeded.
- **A failed run moves nothing on.** Its objects are deleted and the next run
  writes the same events again. If the deletion fails, it is retried on later
  runs.
- **A restart mid-run** leaves a run marked *running*. Its object keys were
  recorded before anything was uploaded, so the next run marks it failed and
  deletes what it wrote.
- **Events written at the same moment** are told apart by their sequence
  number, so a boundary between two runs never splits or repeats them.
- **Transactions still in progress** cannot be passed over: the upper bound is
  read under a brief `SHARE` lock on the table, which waits for every
  transaction already writing to it. The lock is held for one index lookup.
  If a writer holds the table for more than two seconds, the attempt is retried
  twice and then the run fails with *stayed busy* and is retried on the next
  run; nothing is skipped.
- **Audit retention** keeps entries the export has not written yet while the
  export is on, so a short audit retention can never open a gap.

Only the folders with a `manifest.json` are complete; a folder without one is
from a run that is still going or failed and is about to be deleted. If you
copy objects elsewhere, `seq` (with the stream) is a unique key you can
deduplicate on.

### Verifying an export

```bash
# The object matches the manifest
sha256sum audit.jsonl              # equals streams.audit.sha256
wc -l < audit.jsonl                # equals streams.audit.count
# Every line is JSON, in order, inside the manifest's range
jq -s 'map(.seq) | (. == sort) and (.[0] > 400) and (.[-1] <= 412)' audit.jsonl
```

For a sequence of runs, check that each manifest's `afterSeq` equals the
previous manifest's `throughSeq`, per stream.

### Destination

As for [backups](backups.md#destination): the attachment bucket under the
reserved `.oci-compliance/` prefix (storage reconciliation never treats these
objects as orphans), or a **separate S3 bucket (recommended)** with its own
region, endpoint, access key and prefix; the secret is stored encrypted with
`ENCRYPTION_KEY` and never shown again. Records meant to be tamper-evident
belong in a bucket with versioning or object lock. **Test destination** writes,
reads back and deletes a small object. The credential needs `s3:PutObject`,
`s3:GetObject`, `s3:DeleteObject` and the multipart upload actions on the
prefix.

Turning the export on is refused while the destination is incomplete.

### Schedule

**Every hour** or **once a day** at an hour (UTC). The `compliance.export` job
checks every five minutes and runs when the current hour (or day) has no
successful export yet; a failed scheduled run is retried after an hour.
**Export now** runs one straight away, in the background; scheduled and manual
runs never overlap.

### Retention of exported objects

Kept by default: institutions usually manage these records under their own
policy. **Delete exported objects after (days)** deletes the objects of older
successful runs at the current destination after each run. Deleting objects
never exports their events again.

### Audit and monitoring

- Changing settings is audited as `compliance.settings.update` (which fields
  changed, never the secret), and kept regardless of audit retention.
- Manual runs, and every failed run, are audited as `compliance.export.run`,
  so a [webhook](observability.md#webhooks) can alert on failures.
- **System health** has a *Compliance export* row: off is fine; the latest run
  failing is an error; no successful export for two periods is a warning. It
  also shows how many people are on legal hold.

## Legal hold

### Placing and lifting

Under **Legal holds**, enter the person's email address and a reason (a matter
or case reference) and choose **Place hold**. **Lift** ends it, with an
optional reason. Both are audited (`compliance.hold.place`,
`compliance.hold.lift`, with the reason) and those entries are kept regardless
of audit retention. Lifted holds stay listed as history.

Held people are marked **Legal hold** in **People → Users** and on their account
page, which shows the reason and who placed it.

### What a hold does

While a person is on hold:

| Normally | Under hold |
| --- | --- |
| [Conversation retention](governance.md#retention) moves inactive conversations to the trash | Skipped for this person |
| The trash is purged after its retention window | Skipped: their trash (conversations and files) is kept |
| Expired temporary chats are deleted | Kept (still invisible to them) |
| Audit retention prunes old entries | Entries by or about them are kept |
| [Memory retention](governance.md#user-memory) deletes notes not updated for a while | Their notes are kept |
| They empty their trash or delete a conversation forever | Refused: *Permanent deletion is paused for this account by your organization.* Moving to the trash still works. |
| An administrator deletes the account | Refused with *This person is on legal hold…*. A database trigger also refuses it on any other path. |

Lifting the hold restores normal behaviour from then on: anything past its
window is removed at the next run of the job concerned.

A hold applies to work that starts after it is placed; a purge already deleting
when the hold is saved is not undone. A hold does not stop the person using OCI
(ban them for that), does not change what the compliance export includes, and
does not cover data outside OCI's database and attachment storage. Removing a
project deletes its files at once and is not paused by a hold.
