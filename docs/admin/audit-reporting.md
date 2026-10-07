# Audit and reporting

## The audit log

![The audit log](../images/admin-audit.png)

**Insights → Audit log.** Who did what, when, and from where.

### What is recorded

**Administrative action** — settings, models, providers, quotas, invitations,
policies, announcements, bulk operations.

**Authentication** — sign-in, sign-up, sign-out, password reset and change,
verification, and single sign-on. Including **failures**, and including for an
account that does not exist, which is what makes a brute-force attempt visible.
A person's own changes in Settings → Account are recorded too: their name
(`auth.profile.updated`) and signing devices out (`auth.session.revoked`,
`auth.sessions.revoked_others`). Revoking share links is recorded as
`share_link.revoke` and `share_link.revoke_all` (v0.10), and a refused attempt
to delete one's own account (wrong password) as `user.delete.failure`.

Attempts refused by the [sign-in limit](governance.md#sign-in-attempts) are
recorded as `auth.rate_limited`, once per minute per address or account.

**Deletions** — every conversation, file, project, memory note and account
moved to the trash, restored or deleted, by the person, an administrator or a
background job (`conversation.trash`, `conversation.delete`,
`attachment.delete`, `project.delete`, `memory.delete`, `user.delete` and
others). Each names what was deleted, whose it was and why, never its
content; see [deletion events](compliance.md#deletion-events).

Only outcomes are recorded. No credentials, no tokens, no request bodies.

### Searching it

Search, action family, and date window are applied **in the query**, across
retained history rather than the page in front of you. Typing `auth.` in the
action filter finds every authentication event without naming each one.

Searching an IP address finds everything that came from it, which is usually
where an investigation starts.

### Export

**Export** produces CSV of everything matching the current filters, up to fifty
thousand rows. Filter first — exporting everything and sorting it afterwards is
slower than asking a narrower question.

### Configuration changes

A settings entry records what a value **was** as well as what it became, so
"who disabled sign-on last Tuesday, and what was it before" has an answer. So
do the entries for a storage allowance, a model edit (a rename names both names,
a switch which way it went), a usage budget edit (its limit, window, roles and
models), a person's limit override (the override it replaced), a bulk role
change (each account's previous role), a ban or unban, single or bulk (the
ban and reason it replaced, so an unban says which reason it lifted), an
account's rename (the name before) and read-only mode (the reason and
expected end before, and the end as saved), and the edits of retention, rate
limits and sign-in attempts, an SSO provider (account-linking trust among
them), an announcement (its window and audience too), a connector (its address
among them), a webhook (the actions it forwards), a scheduled report and an
acceptable-use draft (its title, and whether the text changed). Each
lists its `changes`, every value as it was and as it became, a nested one by
its path (`roles.user.chatRequestsPerMinute`); an announcement, webhook or
acceptable-use save that changes nothing is not recorded. Every **Test** button
that reaches an outside service is recorded with its outcome (`smtp.test`,
`storage.test`, `search.test`, `embeddings.test`, `reranking.test`,
`backup.test`, `compliance.test`, `connector.test`, `webhook.test.send`). A deletion records what was removed: a
deleted usage budget keeps its measure, limit, window, roles, models and how
many per-user overrides went with it, a deleted storage allowance its values,
and a cleared override its limit. **Sign out everywhere** records how many sessions it ended.

Secret values record only whether they are set, cleared, or replaced. The value
never enters the log.

## Usage

![Usage](../images/admin-usage.png)

**Insights → Usage.** What has been consumed: totals, daily volume, a breakdown by model, and the
heaviest consumers.

Token totals contain reported usage; cost is calculated from the catalog prices
snapshotted for that request. Neither includes the estimates held by quota
enforcement, and they are not an authoritative provider invoice. Missing or
incomplete reports are stored as unknown, not proof of zero spend. Partial
reports preserve cumulative reported counts; a complete report can correct the
original UTC-day rollup without counting another message.

Unresolved events are exempt from normal usage-event retention until resolved,
so their identity and original prices remain available for reconciliation.
A quota meter can include held allowance not yet present in daily totals.
Historical losses from older non-transactional accounting are not repaired
automatically by an upgrade.

### How the figures are read

From v0.11 this page, the scheduled reports and every usage budget read
**hourly usage totals** kept alongside the individual usage records, so they
stay fast however much history the instance holds. The figures are exact, not
estimates: they always equal what adding up the individual records would give,
including usage recorded a moment ago, days that start at midnight in the
reporting time zone (half- and quarter-hour zones included), and the
**Deleted accounts** row. They cover the same history as the usage records
and are pruned with them by usage history retention.

After an upgrade to v0.11 the totals for earlier usage are filled in by a
background task (**System health → Background work**, *Adds usage recorded
before 0.11 to the hourly usage rollups*). Until it finishes the page reads
the individual records as before: the numbers are the same, only slower.
About 125,000 usage records take ten seconds.

### Deleted conversations

Usage records are kept when a conversation is deleted, so **Messages** (each
reply generated, regenerations included, as usage budgets count them), tokens
and spend do not change afterwards. The Overview tab's **Conversations**,
**Messages sent** and **Attachments**, and its feature counts, count what is
still stored, so they leave out anything deleted since; on an instance where
people delete conversations, **Messages sent** can be well below the replies
and Spend's **Messages** for the same days.

### Deleted accounts

Deleting an account keeps its usage records (events, daily totals and limit
refusals) without anything that identifies the person, so totals, the daily
and per-model figures and scheduled reports do not change afterwards:

- **Top consumers** and the scheduled report's **Heaviest use** show the usage
  of every deleted account as one **Deleted accounts** row, ranked with
  everyone else.
- **People** (and **Active people** in reports) and **people affected** on the
  Limits tab count accounts that still exist; a deleted person's usage stays
  in every other figure.
- A person's own usage meter and their page under People never include it.
- Usage history retention prunes these records by age like any other,
  including unresolved ones, since nothing can amend them any more.

Only a run still in progress at the moment of deletion loses its reserved
allowance; it was never part of the reports. Usage records written before
this behaviour (v0.10) for accounts already deleted were removed at the time
and cannot be recovered.

Use it before setting a quota. A limit chosen from observed use lands better
than one chosen from an assumption, and this page is how you find out what
ordinary use looks like on your instance.

## Scheduled reports

![Scheduled reports](../images/admin-reports.png)

**Insights → Reports.** A usage summary delivered by email, daily, weekly, or
monthly.

Somebody who wants a monthly figure will not remember to open a page for it,
which is the entire reason these exist. Send the monthly summary to whoever asks
about spend and the questions stop.

Points worth knowing:

- **Due-ness is decided from the last send**, not a calendar expression. A
  replica that was down over a boundary sends once when it returns rather than
  skipping the period. Each report shows when it is next sent: a day, week or
  30 days after its last send, checked hourly ("within the hour" once due), or
  **Paused**.
- **Edit** loads a report into the form to change its name, cadence, window
  or recipients; **Pause** stops it without losing it.
- **Send due now** exists so you can check the recipients and the content
  without waiting a month to discover the address was wrong.
- **A failure is recorded on the report**, not only in the logs, so you can see a
  report has been failing without reading server output.
- Reports need email configured. Without SMTP none will arrive: the Reports
  page warns until email delivery is set up, enabling a report makes email a
  required step on the [setup checklist](first-run.md#5-set-up-email-delivery),
  and [System health](operations.md#health) reports email as not configured.
