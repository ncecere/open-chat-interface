# Changelog

All notable changes to Open Chat Interface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
