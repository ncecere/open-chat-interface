# Changelog

All notable changes to Open Chat Interface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- An administration usage report covering activity, spend by model and person,
  limit denials, and storage consumption, with a configurable reporting
  timezone. Every figure is a count or a total; nothing reads conversation
  content.
- Per-user quota overrides with an optional expiry and reason, for policies a
  person's role already carries.
- Configurable reservation amounts, so how much a run holds before its real
  usage is known can be tuned per instance.
- Single-conversation Markdown download.

- Quota policies can be scoped to specific models, so a family such as Anthropic
  or OpenAI carries its own independent budget. An unscoped policy still applies
  to every model, and a model in no policy remains unlimited.
- Per-role storage allowances covering total bytes, stored file count, and
  maximum file size, enforced per user before an upload is written.
- Trash for deleted conversations, restorable until a configurable grace period
  elapses, with immediate permanent deletion and empty-trash actions.
- Optional retention for inactive conversations, usage history, audit entries,
  share links, and expired authentication artifacts.
- Per-role concurrency caps and rate limits for chat and uploads, plus per-IP
  and per-account limits on authentication attempts.
- In-app usage warnings before a limit is reached, and a storage meter in
  attachment settings.
- Administration for storage allowances, retention, rate limits, background job
  health, and storage reconciliation.
- Background job runner using per-job advisory locks so scheduled maintenance
  runs once across replicas rather than once per replica.

### Fixed

- Attachment objects are no longer orphaned when a thread or user is deleted.
  Cascading deletes bypass the application entirely, so a database trigger now
  queues every removed blob for deletion with retries.
- Attachments are removed with the message they were sent on instead of being
  detached, which previously stranded both the row and its stored object and
  made an already-sent attachment appear re-sendable.
- Cost and token reservations now hold an estimated amount that settles to
  actual, so concurrent expensive generations can no longer read the same
  pre-spend total and collectively exceed a budget.
- Listing conversations no longer performs expiry cleanup as a side effect of a
  read.

### Changed

- Storage drivers can enumerate stored objects, which reconciliation needs to
  detect blobs with no database row and rows with no object.

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

[Unreleased]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/compare/v0.1.0...main
[0.1.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.1.0
