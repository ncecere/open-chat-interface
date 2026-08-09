# Administering Open Chat Interface

The administrative dashboard is at `/admin`, available to accounts with the
`admin` role. An `auditor` may read every page here and change nothing.

![The administrative overview](../images/admin-overview.png)

## Contents

1. [First run](first-run.md) — what to configure before anybody signs in.
2. [Instance settings](instance-settings.md) — sessions, branding, announcements.
3. [Identity and access](identity.md) — local accounts, OIDC, SAML, group role
   mapping, the auditor role.
4. [People](people.md) — users, invitations, bulk actions, saved views.
5. [Models and providers](models-providers.md) — credentials and the catalogue.
6. [Governance](governance.md) — quotas, storage, rate limits, retention,
   acceptable use.
7. [Operations](operations.md) — health, storage, search, maintenance.
8. [Audit and reporting](audit-reporting.md) — the audit log, exports, usage,
   scheduled reports.

For deployment, backup, and upgrade, see [Operations](../OPERATIONS.md).

## The pages, in one line each

**Instance**

| Page | What it is for |
| --- | --- |
| Overview | Activity, totals, and whether the parts are working |
| Settings | Registration, sessions, features, default model, email |
| Branding | Name, logo, accent colour, sign-in message |
| Announcements | A banner shown to everybody |

**People**

| Page | What it is for |
| --- | --- |
| Users | Accounts, roles, bans, sessions, bulk actions |
| Invitations | Invite links when registration is closed |
| Auth & SSO | Identity providers and how they map to roles |
| Acceptable use | A policy people must accept before using the instance |

**Models**

| Page | What it is for |
| --- | --- |
| Providers & Keys | Upstream credentials |
| Model catalog | Which models exist and who may use them |

**Governance**

| Page | What it is for |
| --- | --- |
| Usage | What has been consumed, by whom, on what |
| Reports | Usage summaries delivered by email |
| Usage quotas | Caps per role, with per-person overrides |
| Storage limits | How much each role may hold |
| Rate limits | Requests per minute and concurrent replies |
| Retention | How long conversations and logs are kept |

**Platform**

| Page | What it is for |
| --- | --- |
| Search | The web search provider |
| Storage | Where attachments live, and reconciliation |
| Health | Whether dependencies are working |
| Maintenance | Background jobs, run by hand |
| Audit log | Who did what, with export |

## On a phone

The dashboard works on a narrow screen, with the navigation behind a menu.
Reading a figure or acknowledging an announcement is comfortable; configuring a
provider is not, and is better done at a desk.

![Administration on a phone](../images/mobile-admin-overview.png)

## The shape of the interface

Every page follows the same pattern: a heading explaining what it is for, then
the controls. Lists that can grow — users, audit entries — filter on the server,
so a search describes everything rather than the page in front of you.

Anything with a consequence that is not obvious from its label says so in place,
rather than leaving you to find out here.
