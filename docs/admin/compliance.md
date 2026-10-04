# Compliance export and legal hold

**Data & storage → Compliance** (`/admin/compliance`). Two tools for
eDiscovery, records requests and security monitoring:

- **Compliance export**: every audit event (including what was deleted, by
  whom and when) and, if you turn it on, conversation content, written as
  [JSON Lines](https://jsonlines.org/) to S3-compatible storage every hour or
  every day. Each run continues exactly where the last one ended.
- **Legal hold**: named people whose data no retention job, purge or deletion
  may remove until the hold is lifted.

An `auditor` sees everything on the page and changes nothing.

## The export

### What is exported

| Stream | When | Each line |
| --- | --- | --- |
| Audit events | Always, while the export is on | One audit log entry: `seq`, `id`, `createdAt`, `action`, `actorUserId`, `actorEmail`, `targetType`, `targetId`, `metadata`, `ipAddress`. Includes [deletion events](#deletion-events). |
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
- Deletions are not exported as messages. Deleting a conversation or an
  account leaves the lines already exported; the deletion itself is a
  [deletion event](#deletion-events) in the audit stream.

### Deletion events

Since v0.10, everything that moves a person's data to the trash, restores it
or deletes it writes one audit entry, so a downstream archive can tell a
deletion from a gap. That includes the person themselves, an administrator
and the background jobs (retention, trash purging, temporary chat expiry,
unused conversation cleanup, memory retention). Each entry is written in the same database transaction as
the change: a deletion is never committed without its entry, and an entry is
never written for a deletion that rolled back. They travel in the audit
stream, so they are exported exactly once like every other audit event, can
be [sent to webhooks](observability.md#webhooks), and are kept by audit
retention while unexported or while their owner is on legal hold.

| `action` | When | Notes |
| --- | --- | --- |
| `conversation.trash` | A conversation moves to the trash: by its owner (`reason: user`) or by conversation retention (`retention`). | `attachments`: files that went to the trash with it. |
| `conversation.restore` | Its owner restores it from the trash. | |
| `conversation.delete` | A conversation is destroyed: deleted forever or the trash emptied (`user`), the trash window elapsed (`trash_expiry`), a temporary chat expired (`temporary_expiry`), a conversation started and never used (untitled, no message, untouched for a day; not pinned, archived or imported) was cleaned up (`unused_expiry`, v0.10.2). | `messages`, `attachments`, `artifacts`: what was destroyed with it; `temporary`, `projectId`. |
| `attachment.trash` | A chat file is deleted on its own (it goes to the trash). | `threadId`, `messageId`, `sizeBytes`. |
| `attachment.delete` | A project file is deleted (`user`), or a file trashed on its own is purged (`trash_expiry`). | `threadId`, `messageId` or `projectId`; `sizeBytes`. |
| `project.delete` | A project is deleted. | `fileIds` and `files`: its files, deleted with it; `conversationsDetached`: its conversations, which are kept. |
| `memory.delete` | A memory note is deleted by the person (`user`), the `forget` tool or undoing a saved note (`tool`), or memory retention (`retention`). One entry per note. | The target is the owner (as since v0.9); also `via`, `memoryId`. |
| `user.delete` | An administrator deletes an account, or a person deletes their own (v0.10: `reason: "user"`, `self: true`). | `conversations`, `messages`, `attachments`, `artifacts`, `projects`, `memories`, `shareLinks`: everything deleted with it; also `email`, `role`. |

Every one of them has the same `metadata.deletion` object:

| Field | Meaning |
| --- | --- |
| `type` | `conversation`, `attachment`, `project`, `memory` or `user`. |
| `id` | The id of what was trashed, restored or deleted. |
| `ownerUserId`, `ownerEmail` | Whose data it was. Kept even after the account is deleted, when `actorUserId` of the person's own entries becomes null. |
| `reason` | `user`, `admin`, `tool`, `retention`, `trash_expiry`, `temporary_expiry` or `unused_expiry`. |
| `permanent` | `true` for `*.delete`; `false` for trash and restore. |

**Who** is `actorUserId` and `actorEmail`: the owner, the administrator, or
null for a background job (the `reason` names the job). **When** is
`createdAt`.

**Never what was deleted**: no conversation titles, file names, project names
or memory text, because audit entries are shown to administrators, sent to
webhooks and kept after the thing itself is gone. What went with a
conversation (its messages, files and artifacts) is counted, and named by the
conversation's id. With **Include conversation content** on, the archive
already holds the messages, keyed by `threadId`, with their file names under
`files[].attachmentId` and their project under `thread.projectId`, so the ids
join a deletion to what it removed.

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
| Conversations started and never used are deleted after a day | Kept |
| Audit retention prunes old entries | Entries by or about them are kept, including [deletion events](#deletion-events) for their data |
| [Memory retention](governance.md#user-memory) deletes notes not updated for a while | Their notes are kept |
| Usage history is pruned after its retention window | Their usage events are kept (daily totals are always kept) |
| Expired and revoked share links are removed after 30 days | Their links are kept (still unusable) |
| They empty their trash or delete a conversation forever | Refused: *Permanent deletion is paused for this account by your organization.* Moving to the trash still works. |
| They delete a project or a project file | Refused: *Deleting projects and project files is paused for this account by your organization.* Projects have no trash, so this would destroy the files at once. |
| They delete memories (in Settings, with the `forget` tool, or by undoing a saved note) | Refused: *Deleting memories is paused for this account by your organization.* Editing a note still works. |
| They delete a chat file | Still works: it goes to the trash, which is kept |
| An administrator deletes the account | Refused with *This person is on legal hold…*. A database trigger also refuses it on any other path. |

Lifting the hold restores normal behaviour from then on: anything past its
window is removed at the next run of the job concerned.

A hold applies to work that starts after it is placed; a purge already deleting
when the hold is saved is not undone. A hold does not stop the person using OCI
(ban them for that), does not change what the compliance export includes, and
does not cover data outside OCI's database and attachment storage: in
particular, [backup](backups.md) retention still deletes old backups.

Every place OCI deletes data is listed, with how it treats a hold, in the test
`apps/api/src/__tests__/unit/legal-hold-paths.unit.test.ts`, which fails when a
new deletion is added without that decision. Deletions that do not check
remove things that are not a person's records: sessions and tokens, connector
credentials, configuration, queues, a failed upload, an empty reply
placeholder, a released usage reservation, and an import upload (what it
imports becomes conversations, which are held). Editing (renaming a
conversation, changing a project's instructions or a memory note) is not
deletion and is not paused.
