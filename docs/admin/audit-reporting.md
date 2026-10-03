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
"who disabled sign-on last Tuesday, and what was it before" has an answer.

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
  skipping the period.
- **Send due now** exists so you can check the recipients and the content
  without waiting a month to discover the address was wrong.
- **A failure is recorded on the report**, not only in the logs, so you can see a
  report has been failing without reading server output.
- Reports need email configured. Without SMTP none will arrive: the Reports
  page warns until email delivery is set up, enabling a report makes email a
  required step on the [setup checklist](first-run.md#5-set-up-email-delivery),
  and [System health](operations.md#health) reports email as not configured.
