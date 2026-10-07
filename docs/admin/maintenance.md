# Read-only maintenance mode

Read-only mode keeps Open Chat Interface open for reading while nothing can be
changed. Use it when a change to the database or its host needs a window: a
database move or restore, a major PostgreSQL upgrade, an OCI upgrade whose
preflight answers "needs a window", or an incident where you want to stop
writes without taking the service down.

It applies on every API replica at once, and to the background workers.

## What keeps working, and what does not

| Keeps working | Refused while read-only |
| --- | --- |
| Opening conversations, projects and files | Sending a message, regenerating, editing, forking |
| Search, project search, meaning-based search | Uploading files, importing conversations |
| Exporting a conversation, a reply or all your data | Changing personal settings, memory, sharing links |
| Signing in (password, single sign-on) and signing out | Signing up, password resets, changing a password |
| Signing other devices out; an administrator ending someone's sessions | Every administration change, apart from the switch itself |
| Stopping a reply in progress | "Run now" for background jobs (apart from those kept running) |
| Hiding an announcement | |
| Replies already being written when it starts: they finish and are saved | |

A refused change is answered before the server does anything with it, so
nothing is half-saved. People see a banner saying why and until when, in the
chat, in Settings and in administration. The message box, upload, edit, fork
and retry buttons are off, with the reason, as are the sidebar's pin, rename
and archive buttons and **New project**, the conversation header's rename,
share, move to project and summarise buttons, a project's save, upload,
remove-file and delete buttons, an artifact's **Edit**, the **Revoke**
buttons under Settings → Sharing, every other control in personal Settings that
saves or deletes something (**Edit name**, **Change Password**, **Delete
account**, **Save Preferences**, **Save defaults**, the memory buttons and
switch, archiving, restoring and deleting conversations, **Choose export
file** for an import, deleting attachments, connecting and disconnecting a
connector), and the controls and Save buttons of administration pages.
Download and signing out of devices stay available. A form already open when
read-only starts has its Save button turned off too. Somebody who sends just as
read-only starts gets that explanation too, not an error, and so does a change
that was refused before the page knew. **Forgot your password?** says password resets
are paused, with the reason and the expected end, and that no email was sent.

A person signing in for the first time can still accept the acceptable use
policy, which is part of signing in. Single sign-on can still create an account
for someone new (just-in-time provisioning).

## Turning it on and off

**Admin → System health → Maintenance.**

- **Turn on read-only mode**, with an optional reason (shown to everyone) and
  an expected end. The expected end is shown to people and sent to API clients
  as `Retry-After`; it must be later than now. Nothing ends by itself, so turn
  it off when you are done. It asks first: focus moves to **Cancel**, and
  only **Confirm: refuse every change now** turns it on. Escape or Cancel
  closes the question and puts focus back on **Turn on read-only mode**.
- **Turn off read-only mode** is the one administration control that stays
  usable while read-only. Changes are accepted again on every replica at once.
  Open pages learn it within 30 seconds: the banner goes, and so does any
  "Read-only for maintenance" message left beside a change that was refused.
  The reason and expected end go with it: the next time, the form starts
  empty.
- **Scheduled window**: a start and an end. From the start until the end the
  instance is read-only without anybody at the switch, and it ends by itself.
  With **Announce it now**, everybody sees an announcement (an ordinary
  [announcement](instance-settings.md)) from now until the window starts,
  saying when and what will not work; the read-only banner takes over at the
  start, on pages already open too. The announcement gives its times in the
  instance's display time zone (Branding); the banner gives the end in each
  person's own time zone. Both name their zone. Changing the window updates its announcement and shows it again to
  people who had hidden it; cancelling the window removes it.

Every change is in the audit log as `maintenance.read_only.update`, with who
made it, when, the reason, the expected end or the window (only one that is in
effect or still to come: a window that has ended is dropped the next time
anything here is changed) and the jobs kept running, and what the reason and
expected end were before. Auditors see this page without its controls. **Health checks** shows a
**Read-only mode** row, a warning while it is on, and the `oci_read_only` metric
is 1 on each replica that refuses writes.

## Background jobs

Jobs that write pause while read-only: retention, imports, embeddings and
summaries, storage cleanup, reports, background migrations and the rest. A job
running when read-only starts finishes the batch in hand and stops; an import
in progress is put back in the queue and continues afterwards from where it
was. Jobs pick up again on their next tick after read-only ends.

Ticked under **Background jobs while read-only**, a job keeps running. By
default:

| Job | Why it keeps running |
| --- | --- |
| `backups.run` | A backup is what you want before the risky part. While it keeps running, a manual backup can still be started through the API (`POST /api/admin/backups/run`); start one from **Backups** before turning read-only on. |
| `compliance.export` | Compliance exports are not interrupted by maintenance. |
| `webhooks.deliver` | Audit events, including the switch itself, still reach your SIEM. |
| `chat.recover-interrupted-replies` | A reply whose replica stopped is saved as interrupted, so its conversation is not left waiting. |

Untick them, or tick others, and **Save jobs**. The list holds the same jobs
as **Background jobs**: those the replicas that run jobs schedule.

## The emergency switch: `OCI_READ_ONLY`

For an emergency, or when the administration pages cannot be reached, set on
**every** API replica and worker, and restart them:

```bash
OCI_READ_ONLY=true
OCI_READ_ONLY_REASON="Restoring the database"   # optional, shown to people
```

It wins over everything on System health and **cannot be turned off from
administration**: the page says the environment holds it. Unset it (on every
replica) and restart to end it. With Docker Compose, both variables are passed
to the `api` and `worker` services from `docker/.env`; with the Helm chart, add
them to the API's and the worker's environment.

## What clients see

A refused request answers **`423 Locked`** with the error code `READ_ONLY`:

```json
{
  "error": {
    "code": "READ_ONLY",
    "message": "This service is read-only for maintenance (Upgrading the database). You can read, search and export, but changes cannot be saved until maintenance ends, expected 2026-10-04 14:30 UTC.",
    "details": {
      "readOnly": {
        "active": true,
        "source": "administrator",
        "reason": "Upgrading the database",
        "until": "2026-10-04T14:30:00.000Z",
        "window": null
      }
    }
  }
}
```

with `Retry-After` (seconds) when the end is known and `X-OCI-Read-Only`
naming the source (`environment`, `administrator` or `schedule`).
`GET /api/maintenance` returns the `readOnly` object above to anyone, signed in
or not.

Why not `503`: the bundled proxy (and most load balancers) takes a replica that
answers `503` out of rotation, and every replica would answer it at once; a
`503` from OCI means a replica is shutting down, which the web app retries.
`423` is a refusal no proxy treats as an unhealthy server and no error budget
counts as a server error. Scripts that write through the API should treat
`423` with `READ_ONLY` as "try again after `Retry-After`", not as a failure of
the request itself.

## See also

- [Upgrades that need a window](../OPERATIONS.md#upgrades-that-need-a-window)
- [Settings changes and other replicas](../OPERATIONS.md#settings-changes-and-other-replicas)
