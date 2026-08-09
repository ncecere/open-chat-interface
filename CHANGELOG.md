# Changelog

All notable changes to Open Chat Interface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-08-08

Administration and onboarding: what an instance tells people when they arrive,
and how an administrator manages it once they are here.

### Added

- An acceptable use policy that people must accept before using the instance.
  Policies are versioned and never edited in place: an acceptance records
  agreement to specific wording, so publishing a change creates a new version
  and re-prompts everyone automatically. A version somebody accepted cannot be
  deleted, since that would destroy the record of what they agreed to.
- A short introduction for new accounts, collecting a name, occupation, tone,
  and any other context. Everything it asks feeds the system prompt, which is
  the only reason to ask. It can be skipped.
- Instance-wide announcements, shown as a banner rather than a toast so a
  maintenance notice stays readable. Dismissal is per person, and editing an
  announcement does not re-show it to those who have already dismissed it; a
  separate action does that deliberately.
- A logo upload for the sign-in page and sidebar, with a short name as a
  fallback. Uploads are validated by content rather than file extension, and
  SVG is rejected: the logo renders before sign-in, where a scriptable image
  would be stored cross-site scripting.
- An information card for each model in the picker, listing its description,
  features, provider, and limits.
- Sorting and filtering on the user list, applied in the query so it describes
  every account rather than the page already loaded.

### Changed

- Roles from SSO group membership now resolve to the most privileged matching
  group rather than the first one listed. Row order is an authoring detail, not
  a privilege decision. Group claims are matched case-insensitively and can be
  read from nested attributes, which SAML and some OIDC providers require.
  **An existing user's role may rise on their next sign-in.**
- Model capabilities are colour-coded in the picker, each with its own hue and
  a matching label. Colour is a second signal rather than the only one.
- The default model is set in instance settings rather than on individual
  catalogue rows.
- Every dropdown is now a themed control rather than the browser's own, so all
  of them match the rest of the interface.

### Removed

- The cost tier field and its `$$` badge. It fed no pricing, quota, rate
  limiting, or routing decision — it was a label whose only effect was to
  render itself, and once it left the model form nobody could edit it. The
  column is dropped in migration `0016`.

### Fixed

- The theme preview swatch showed the accent already in effect rather than the
  one it advertised.
- A section header in the sidebar was smaller than the 24px minimum target size
  required by WCAG 2.2.
- Accessibility scans no longer run while the theme transition is still
  animating, where they sampled blended colours and reported contrast failures
  against values nobody ever sees.

## [0.2.1] - 2026-08-07

### Fixed

- A reasoning model no longer leaves the screen blank while it thinks. The
  typing indicator was tied to the last message still being the user's, so it
  disappeared the moment an empty assistant message was created, which is
  exactly when a model begins working and the wait is longest. It now persists
  until the response actually produces something.

### Changed

- The reasoning panel opens itself while thinking is the only thing happening
  and collapses once the answer begins. An explicit click still wins.
- The model dialog explains whether a provider can show a model's thinking at
  all, since that depends on the wire protocol and the model rather than on any
  setting in this application.

## [0.2.0] - 2026-08-07

Governance and lifecycle management: what people are allowed to consume, how
long their data is kept, and what an operator can see about both.

### Added

- Quota policies can be scoped to specific models, so a family such as
  Anthropic or OpenAI carries its own independent budget. An unscoped policy
  still applies to every model, and a model in no policy remains unlimited.
- Per-user quota overrides with an optional expiry and reason, adjusting a
  limit the person's role already carries.
- Per-role storage allowances covering total bytes, stored file count, and
  maximum file size, enforced per user before an upload is written.
- Trash for deleted conversations, restorable until a configurable grace period
  elapses, with immediate permanent deletion and empty-trash actions.
- Optional retention for inactive conversations, usage history, audit entries,
  share links, and expired authentication artifacts. Security-relevant audit
  actions are kept regardless.
- Per-role concurrency caps and rate limits for chat and uploads, plus per-IP
  and per-account limits on authentication attempts.
- An administration usage report covering activity, spend by model and person,
  limit denials, and storage consumption, with a configurable reporting
  timezone. Every figure is a count or a total, and usage records carry no
  reference to a conversation.
- Configurable reservation amounts, so how much a run holds before its real
  usage is known can be tuned per instance.
- Single-conversation Markdown download.
- In-app usage warnings before a limit is reached, and a storage meter in
  attachment settings.
- A background job runner using per-job advisory locks, so scheduled
  maintenance runs once across replicas rather than once per replica, with an
  administration view of what ran and what it touched.
- Storage reconciliation that compares object storage against the database in
  both directions.

### Fixed

- Attachment objects are no longer orphaned when a thread or user is deleted.
  Cascading deletes bypass the application entirely, so a database trigger now
  queues every removed object for deletion with retries.
- Attachments are removed with the message they were sent on instead of being
  detached, which previously stranded both the row and its stored object and
  made an already-sent attachment appear re-sendable.
- Cost and token reservations now hold an estimated amount that settles to
  actual, so concurrent expensive generations can no longer read the same
  pre-spend total and collectively exceed a budget.
- Listing conversations no longer performs expiry cleanup as a side effect of a
  read.

### Changed

- Administration is reorganized: Governance holds usage, quotas, storage
  limits, rate limits, and retention, while Platform keeps service
  configuration and gains a Maintenance view. This separates what people are
  allowed to do from where things are wired up.
- Usage is presented to users as a percentage remaining rather than messages,
  tokens, or spend, and limit messages no longer quote the underlying figure.
- Storage drivers can enumerate stored objects, which reconciliation needs to
  detect objects with no database row and rows with no object.

### Upgrade notes

- Applying this release runs four migrations, one of which adds a trigger on
  the attachment table and backfills per-user storage counters.
- Deleting a conversation now moves it to a trash for 30 days by default rather
  than removing it immediately. Adjust or disable this under
  **Governance → Retention**.
- Automatic conversation retention is off by default and must be enabled
  deliberately.
- Storage allowances and rate limits start unlimited and unenforced; existing
  behavior is unchanged until an administrator sets them.

## [0.1.0] - 2026-08-07

Initial release.

### Added

- Multi-model chat with streaming responses, reasoning controls, Markdown, KaTeX,
  syntax-highlighted code, model attribution, and a curated model catalog.
- Local email/password authentication plus administrator-configured OIDC and
  SAML, invite/open/closed registration, account linking controls, and
  `admin`, `user`, and `restricted` roles.
- Immutable message branching, conversation forks and lineage, pinned and
  archived threads, temporary chats, and privacy-filtered public share links.
- File attachments with strict validation, extraction, ownership checks, local
  or S3-compatible storage, and an attachment manager.
- Grounded web search through Tavily, Brave, Exa, or self-hosted SearXNG, with
  persisted citations and external-link confirmation.
- Administration for providers, models, quotas, users, invitations, SSO, SMTP,
  storage, search, branding, themes, and audit events.
- Message, token, and cost quotas with rolling or calendar windows, concurrent
  reservations, and integer micro-dollar accounting.
- Redis-backed resumable streams, multi-replica-safe database migrations, Caddy
  service discovery, and readiness/liveness health checks.
- Docker Compose deployment and versioned API/web images in the GitLab
  container registry.
- Automated linting, type checking, unit/integration/live tests, Playwright and
  WCAG 2.2 AA regression checks, SAST, dependency scanning, SBOM generation,
  license policy enforcement, and GitLab Code Quality reporting.

### Security

- Provider credentials and other managed secrets are encrypted at rest and use
  write-only update semantics.
- Chat history, model resolution, attachment access, branching, and sharing are
  reconstructed and authorized server-side rather than trusted from clients.
- Outbound provider URLs are scheme-validated, search input cannot select an
  origin, and browser API requests are constrained to the current origin.
- External links require explicit confirmation, with optional remembered
  consent.

### Known limitations

- Automated accessibility testing is a regression net, not a complete WCAG
  conformance assessment; manual assistive-technology testing is still advised.
- Local attachment storage is suitable for a single API replica. Multiple
  replicas require shared S3-compatible object storage.
- Token and cost quotas depend on providers returning usage metadata. Providers
  that omit it record zero tokens and cost.
- This initial release has no earlier database version to roll back to. Back up
  PostgreSQL and attachment storage before future upgrades.

[Unreleased]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/compare/v0.2.1...main
[0.2.1]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.2.1
[0.2.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.2.0
[0.1.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.1.0
