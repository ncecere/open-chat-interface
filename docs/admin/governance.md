# Governance

Who may consume what, how much, and for how long it is kept.

## Roles and access

![Roles & access](../images/admin-roles.png)

**People → Roles & access** (`/admin/roles`) gathers everything that shapes
one role on one page, with a tab per role. The values come from the same code
that enforces them, so the page cannot disagree with what somebody in that role
experiences.

For each role:

- **People with this role** — a count that opens the user list filtered to
  that role.
- **Models** — how many of the available models (enabled, on an enabled
  provider) the role can see. Visibility is set per model on
  [Providers & Models](models-providers.md).
- **Features** — editable switches for web search, file attachments, share
  links, temporary chats, branching and projects, plus the reasoning levels the
  role may choose. See [Features and reasoning levels](#features-and-reasoning-levels).
- **Fixed rules** — what is always true for the role and no setting changes:
  administrators have full access; auditors can view administration but not
  change it.
- **Rate limits** and **Storage allowance** — editable here; see below.
- **Usage budgets** — the budgets assigned to the role, read-only, with a link
  to [Usage budgets](#usage-budgets) to change them.

Below the role tabs, **Instance-wide** holds the limits that apply to everybody
regardless of role: sign-in attempts per minute (counted per IP address and per
account), and the cost and tokens reserved while a response generates.

### Features and reasoning levels

Each role has its own switches for **web search**, **file attachments**,
**share links**, **temporary chats**, **branching** (forking a conversation
or editing an earlier message into a new branch) and **projects**. A role switch
can only narrow what the instance offers. Somebody can use a feature when both
of these are on:

- the instance-wide switch, under **Appearance & features → General** (or, for
  web search, the [Web search](operations.md#web-search) page, which also needs
  a working provider);
- the switch for their role, here.

When the role's switch is on but the instance's is off, the page says so under
the switch. The server enforces both; hiding a control in the interface is a
convenience, not the boundary. A request for a feature the role does not allow
is refused with `403` and a message such as "Attachments are not available for
your role"; a feature switched off instance-wide is refused as before.

**Reasoning levels** choose which effort levels (Low, Medium, High) the role
may pick on models that offer effort control. Instant is always allowed. The
model picker offers, and the server accepts, only levels that both the model
and the role allow; a model whose only levels are withheld from the role is
shown without effort control.

Out of the box the switches reproduce the rules that were fixed before they
were configurable: the `restricted` role cannot upload attachments, create
share links or start temporary chats, and every other role can use everything
the instance offers, at every reasoning level. Projects, added later, follow the
same line and are off for `restricted` until you turn them on. Saving sends only
the fields you changed, and each save is recorded in the audit log as
`role.features.update` with the previous and new values. Auditors see the
switches but cannot change them. API: `PUT /api/admin/roles/:role` with any of
`webSearch`, `attachments`, `shareLinks`, `temporaryChat`, `branching`,
`projects` (booleans) and `reasoningEfforts` (a list that must include
`instant`).

### Projects

[Projects](../user/projects.md) let a person group conversations under shared
instructions (up to 8,000 characters) and files (up to 20 per project; 100
projects per person). There is no instance-wide switch: the role's **Projects**
switch alone decides. Governance follows the features projects reuse:

- **Files** are attachments. Uploading needs file attachments to be allowed
  for the role and the instance, uses the upload rate limit, and counts against
  the [storage allowance](#storage-allowance). Removing a file, or deleting its
  project, deletes it at once (not to the trash) and frees its allowance; the
  stored object is removed by the usual storage reaper. Project files are never
  reported as stale uploads or treated as orphans by storage reconciliation.
- **Context**: project instructions are appended to the system prompt after the
  instance prompt and the person's personalisation, delimited and marked as
  subordinate to them. File text is budgeted like any attachment and left out
  when it does not fit the model's context.
- **Switching projects off for a role** keeps existing projects and their files
  (still counted against storage) but refuses every project request with `403`
  ("Projects are not available for your role"), and stops their instructions
  and files being added to conversations, which carry on as ordinary ones.
  Without file attachments, instructions still apply but files are not used.
- **Retention** applies to conversations, not projects: an inactive
  conversation in a project is trashed as usual, and the project stays.
  Deleting a project detaches its conversations; it never deletes them.
- **Audit**: like conversations and share links, creating, changing and
  deleting projects is personal content and is not written to the audit log.
- **Export** includes each project's name, instructions and files.
- Deleting an account deletes its projects and their files.

The level a new conversation starts at is set instance-wide as **Default
reasoning level** on [General settings](instance-settings.md). When the chosen
model or the person's role does not allow it, the composer starts at Instant.

### Tools

Models with the `tool_calling` capability can call **tools** during a reply
(see [Tools](../user/tools.md) for what people see). The **Tools** section of
a role lists every tool OCI can offer with a switch per role. A tool is
offered to a model only when all of these hold:

- the model's catalogue entry has the `tool_calling` capability (edit it on
  [Providers & Models](models-providers.md));
- the role's switch for the tool is on;
- the tool is switched on for the instance, and for the message where the
  composer has a switch. Web search (`web_search`) needs the instance's web
  search to be on and configured, the role's **Web search** feature, and the
  person's **Search** switch for that message. A connector tool
  (`mcp__<connector>__<tool>`) needs its connector and the tool enabled on
  [Connectors](connectors.md) and, for a connector where each person signs
  in, the person's own connection.

Each tool is `read` (looks something up; runs without asking) or `write`
(changes something elsewhere; the person approves every call). The switches
are stored sparsely, so a tool added later inherits a default: built-in read
tools are on for every role except `restricted`; write and connector tools are
off until you allow them. Connector tools appear in this section once enabled
on [Connectors](connectors.md), grouped under their connector's name, and
their allows are removed when the connector is deleted. Saving sends only the tools you changed and is
recorded as `role.tools.update` with the previous and new values. Auditors see
the switches but cannot change them. API: `PUT /api/admin/roles/:role/tools`
with `{ "tools": { "web_search": true } }`.

With a tool-calling model and Search on, the model searches when it chooses,
possibly several times, instead of OCI running one search before the reply.
Models without tool calling, and roles whose `web_search` switch is off, keep
the single search before the reply.

Every tool call writes a `tool.call` audit event: the tool id, its kind,
whether it needed approval and the answer (`approved`, `denied`,
`not answered`), the outcome (`ok`, `error`, `denied`, `refused`), duration
and result size. Inputs and results are never written to the audit log; they
live in the conversation and follow its retention, including for temporary
chats. A call to a tool outside the reply's tool set is refused and recorded as
`refused`.

A reply's steps are limited by **Tool step limit** on
[General settings](instance-settings.md#general). Each step after the first
checks the person's remaining [usage budget](#usage-budgets) and ends the reply
if it is spent; usage is settled for the whole reply, across all its steps.

### Where a value comes from

Each rate limit and instance-wide value carries a label:

- **Saved** — set on this page. This wins over everything else.
- **From environment** — set by an environment variable such as
  `RATE_LIMIT_CHAT_PER_MINUTE`, and used because nothing is saved.
- **Built-in default** — neither is set.

Saving a field here overrides the environment for that field only; fields you
did not change keep inheriting. [Retention](#retention) values carry the same
labels.

## Usage budgets

![Usage budgets](../images/admin-quotas.png)

**Models → Usage budgets** (`/admin/quotas`). A budget — a quota policy —
caps consumption, and is applied to one or more roles. A role can carry several
at once and every one is enforced; each person gets the full amount on their
own. Three things to decide.

### What to measure

| Metric | Suits |
| --- | --- |
| **Messages** | Simplest to explain. "500 messages a month" is understood without translation. |
| **Tokens** | Closer to real cost, since a long conversation costs more than a short one. Harder to explain to somebody who hits it. |
| **Cost** | Exact, and the only one that means anything across models of different prices. |

Measure cost when models differ in price, messages when they do not. Tokens are
mostly a worse version of one or the other.

### Which window

- **Rolling** — the last 24 hours or 7 days, moving continuously. Capacity
  returns gradually as usage ages out. Smoother, and harder to game.
- **Calendar** — resets on a boundary. Easier to explain, and produces a rush at
  the start of each period.

### Which models

A quota can apply to everything or to specific models. Scoping is what lets you
be generous with an inexpensive model and strict with an expensive one, which is
usually what you actually want.

### A worked example

A department wants staff using a costly model without an open-ended bill.

- Metric: **cost**
- Window: **calendar month**
- Scope: **the expensive model only**
- Limit: enough for ordinary use; look at [Usage](audit-reporting.md#usage) for a
  fortnight first rather than guessing

People are warned as they approach the limit — at eighty per cent, and again at
ninety-five. The thresholds are fixed, not set per budget. The warning matters:
somebody who hits a wall with no notice files a ticket; somebody warned at
eighty per cent adjusts.

### Overrides

An individual can be granted more without changing the policy, from **Limits**
beside their name in [the user list](people.md) or **Adjust limits** on their
account page. Set an expiry where the need is temporary.

## Storage allowance

How much each person in a role may hold in attachments: total storage, number of
stored files, and the largest single file. A blank total or file count means no
limit; a blank per-file size falls back to the instance upload limit on
[Storage](operations.md#storage). **Enforce allowance** switches the allowance off without losing the values; a
role with nothing saved is unlimited. Set on **People → Roles & access**.

Storage is a **gauge, not a flow**: it measures what somebody holds now, not
what they have ever uploaded. In-progress uploads reserve space. Deleting files
or moving their conversation to trash frees allowance immediately, even while
the objects remain recoverable. Restoring a conversation requires enough free
allowance for its files.

## Rate limits

Concurrent responses, messages per minute, and uploads per minute, per role,
also on **Roles & access**. Each value shows
[where it comes from](#where-a-value-comes-from).

These are not a budget — that is what usage budgets are for. They stop one client
overwhelming the instance, and a person working normally should never meet one.

The concurrency cap does double duty: it bounds how far a quota can be overshot
by simultaneous requests, since each reserves budget before anybody knows what
it will cost. These are estimates, not a guarantee that a provider bill cannot
exceed the configured budget. Use provider-side spending controls where a hard
financial cap is required.

A complete usage report replaces the estimate. If a provider omits usage, the
remaining estimate stays held within the policy window rather than treating the
request as free. It is released when complete usage arrives, a never-started
attempt is safely cancelled, or the request ages out of that policy window.
The fifteen-minute recovery sweep marks abandoned usage as unknown; it does not
forgive uncertain spend or take over active generations.

The amounts held while a response generates are the **Budget held per
response** and **Tokens held per response** values under **Instance-wide**.

## Retention

![Retention](../images/admin-retention.png)

**Data & storage → Retention.** How long conversations, usage history, and audit
entries are kept. Each field shows
[where its value comes from](#where-a-value-comes-from).

- **Conversation retention** — inactive conversations move to the trash after
  this long; blank keeps them forever. Nobody thanks you for a short period they
  were not told about; state it in your acceptable use policy. Shared
  conversations are not exempt. **Keep pinned conversations** exempts anything a
  person has pinned.
- **Trash retention** — the recovery window before a deletion becomes permanent.
- **Usage history** — per-message usage rows. Daily totals are kept regardless.
- **Reporting timezone** — where a day starts and ends on the Usage page. Budgets
  reset on their own timezone, which this does not change.
- **Audit log** — how long the record of administrative action survives.
  Check what your institution requires before shortening this. Access-control
  and security changes are kept regardless: account creation, edits and
  deletion, role changes (including bulk role, ban and unban), provider and
  single sign-on changes, sign-in policy changes, webhook endpoint changes and
  backup settings changes.

Retention is easier to introduce early and shorten later than to impose on an
instance where people have accumulated two years of work.

## Acceptable use

![Acceptable use](../images/admin-policies.png)

**Sign-in & security → Acceptable use.** A policy people must accept before
using the instance.

### Versioned, never edited

Publishing a change creates a new version. An acceptance records agreement to
specific words, so rewriting the text under an existing acceptance would make
the record untrue.

Consequences:

- **Publishing a new version re-prompts everybody**, automatically. Nobody has
  accepted a version that did not exist when they last signed in.
- **Somebody re-prompted is told the policy changed**, rather than being shown it
  as though it were new.
- **A version somebody accepted cannot be deleted.** The database refuses,
  because deleting it would destroy the record of what they agreed to.

### What is recorded

The version, the moment, and the address it came from. Enough to answer "what
exactly did this person agree to, and when" later.

### Practical advice

Publish before opening the instance. A policy published afterwards prompts
everybody at once, which looks like an incident to people who have been working
happily for months.
