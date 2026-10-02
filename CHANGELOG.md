# Changelog

All notable changes to Open Chat Interface are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Feature entitlements per role.** On Roles & access each role has switches
  for web search, file attachments, share links, temporary chats and branching,
  and a choice of allowed reasoning levels (Instant is always allowed). A
  feature is available only when both the instance-wide switch and the role's
  allow it; the server enforces each one, including web search on a chat turn
  and reasoning levels in `/models` and chat validation. Saved through
  `PUT /api/admin/roles/:role` (changed fields only, audited as
  `role.features.update`, read-only for auditors). Defaults match the previous
  fixed rules, so restricted accounts still cannot upload, share or start
  temporary chats until an administrator changes it. Refusals now read "…is
  not available for your role". No database migration.
- **Default reasoning level** on General settings (`defaultEffort` in
  `PATCH /api/admin/settings`, exposed to clients in `/api/me`). New
  conversations start at it, clamped to what the selected model and the
  person's role allow, falling back to Instant.
- **Export everything and import from ChatGPT or Claude** (Settings → History →
  Your data). `GET /api/me/export` streams a ZIP of every active and archived
  conversation (Markdown plus a complete JSON record with reasoning), the
  person's attached files, `manifest.json` and `README.txt`; trashed and
  temporary chats are excluded. One export at a time per person, audited as
  `user.export`. `POST /api/me/imports` accepts a ChatGPT or Claude export
  `.zip` (including ChatGPT's split 2026 layout and nested Privacy Portal
  archives) or a bare `conversations.json`, up to `IMPORT_MAX_UPLOAD_BYTES`
  (default 512 MB), and processes it in the background (`imports.process`
  job, resumed after restarts). Only the visible branch is imported, with
  titles, timestamps and reasoning; re-importing skips conversations already
  present. Imports are streamed, bounded against zip bombs and unsafe paths,
  do not count towards usage limits, and are audited as `user.import`.
  `GET /api/me/imports` lists them and `DELETE /api/me/imports/:id` cancels or
  removes one. Migration `0022_conversation_imports` adds the
  `conversation_import` table and `thread.import_source`/`import_source_id`.
  New dependencies: `fflate`, `@streamparser/json`, `busboy` (all MIT).
- **Full-text conversation search.** The sidebar search and the command palette
  now search message text as well as titles, with prefix matching (every word
  must appear), best match first and up to three highlighted lines per
  conversation. Only `text` parts are searched — not reasoning, sources or
  attachment contents. Archived conversations are included and flagged;
  trashed and temporary ones are not. Choosing a result opens the
  conversation at the matching message (`/chat/:id?message=:messageId`),
  centred, briefly highlighted (a still outline under reduced motion) and
  focused, instead of at the end. New `GET /api/threads/search?q=&limit=`
  (default 20, at most 50) returns thread summaries, a rank, a marked title
  and `{messageId, role, snippet}` matches; matches are marked with the
  control characters U+0001/U+0002, never HTML. `GET /api/threads?search=`
  (title substring) is unchanged. Migration `0023_message_text_search` adds a
  GIN index on message text; on a large instance it takes time to build and
  blocks writes to `message` while it does — see the upgrade notes in
  `docs/OPERATIONS.md`.

## [0.6.1] - 2026-10-01

Providers & Models split into tabs. No database migrations; deploy the API and
web images as a pair.

### Changed

- **Providers & Models** (renamed from Providers & models) has a Providers tab
  and a Models tab, kept in the URL (`?tab=models`), like Roles & access.
  Setup checklist links open the tab that resolves each item.

## [0.6.0] - 2026-10-01

Administration organised around the tasks administrators do, with guided setup,
a single page for role access and actionable user accounts; correctness fixes
found along the way; and chat that keeps up with a streaming reply.

### Added

- **Setup checklist on the admin Overview.** Computed by the server from stored
  configuration — provider, models, default model, sign-in method, email
  delivery (required when verification or scheduled reports depend on it),
  attachment storage, web search, acceptable use and Redis — with a link to
  the page that resolves each item. Nothing in it contacts an external service.
- **Roles & access page** (`/admin/roles`). Per role: people count (linked to
  the filtered user list), fixed rules, effective features, visible models,
  editable rate limits and storage allowance, and assigned usage budgets; plus
  instance-wide sign-in attempts and reservation amounts. Rate-limit and
  retention values show whether they come from saved settings, an environment
  variable or the built-in default.
- **User account page actions.** Change role (confirmation when granting or
  removing administrator access), ban and unban, sign out everywhere, and a
  Limits section showing each budget's usage and reset time, storage against
  the role's allowance, per-person adjustments and a link to role settings. The
  user list has a role selector on each row.

### Changed

- **Administration is grouped by task**: People, Models, Sign-in & security,
  Data & storage, Insights, and Appearance & features. Merged pages keep their
  old addresses as redirects: `/admin/providers` to Providers & models,
  `/admin/sso` to the single sign-on section of Authentication,
  `/admin/rate-limits` and `/admin/storage-limits` to Roles & access,
  `/admin/maintenance` to System health, and `/admin/settings` to General.
- Instance settings are separate pages (General, Authentication, Email delivery).
  The default model is chosen on Providers & models; background jobs and
  storage reconciliation are on System health.
- Web search has a single switch on the Web search page, and clients are
  offered search only when it can run.
- Branding's **Accent color** is now the instance accent preset (neutral, blue,
  violet, emerald), moved from General and replacing the hex colour field.
  **Default theme** now applies to people who have not chosen a theme.
- Auditors can open every admin page read-only, with a banner; controls that
  would change something are hidden or disabled.
- On narrow screens the admin navigation opens in a drawer from a menu button,
  wide tables scroll within the page instead of widening it, and provider rows
  wrap their actions below the details. Admin tab strips follow the standard
  keyboard pattern (arrow keys, Home and End).
- Admin pages report failed saves, confirm destructive actions such as deleting
  a provider or banning in bulk, and offer a retry when a page fails to load.
  The Canvas, MCP and session-refresh controls, which had no effect, are removed.

### Fixed

- **Conversations scroll with what is happening.** A sent question moves to the
  top of the view with room below for the reply, and the view follows a
  streaming reply once it fills the screen. Scrolling up stops following and
  shows **Jump to latest**. Long conversations also open at their end; before,
  they could stop well short of it.
- Banning a single account now ends its sessions immediately, as bulk bans
  already did.
- Concurrent default-model changes are serialised, so exactly one model remains
  the default.
- **Saving one administrative field no longer resets others.** Partial updates
  applied create-time defaults to fields that were not sent: saving any instance
  setting reset the session lifetime to 30 days, toggling or renaming a model
  cleared its default flag, capabilities, reasoning efforts, role visibility and
  order, and pausing a scheduled report reset its window to 30 days. Omitted
  fields now stay unchanged. Re-check those values if they were edited before.
- **Audit-log retention now runs.** The pruning query was rejected by PostgreSQL
  on every run, so audit entries were never removed and the job reported failure.
- Single sign-on providers can be edited to the auditor role, matching creation,
  and a claim mapping to the auditor role now takes effect at sign-in.

### Security

- Role changes and sign-in policy changes are recorded under protected audit
  actions that retention never removes; bulk role, ban and unban are protected
  too. Model discovery against a provider is now audited.

### Upgrade notes

- No new database migrations since 0.5.0. Deploy the API and web images as a
  pair.
- Before this release, saving one administrative field could reset others.
  After upgrading, check session lifetime, each model's visible roles,
  capabilities and default flag, and scheduled report windows.

## [0.5.0] - 2026-10-01

Chat reliability, privacy and accounting under concurrency, with measured startup
improvements and explicit recovery and rollout contracts.

### Fixed

- Reserve a durable response claim before expensive chat preparation. Cache loss
  or age alone no longer permits competing producers to take over a conversation.
- Reserve upload capacity atomically and settle usage transactionally. Ambiguous
  uploads retain capacity; partial usage cannot erase known consumption, and
  unresolved reservation records survive retention until they can be reconciled.
- Keep shared conversations private after deletion, expiry and restore. Restoring
  a conversation does not reactivate its old public links.
- Pin migration ownership to one physical PostgreSQL transaction and check the
  latest required migration before starting with automatic migrations disabled.
  Maintenance locks clean up private connections, including forced shutdown.
- Reconcile interrupted replay against the exact saved response without treating
  a reader disconnect as cancellation. Preserve drafts, accepted attachments and
  canonical prompt identity across interruption, navigation and recovery.
- Reconstruct historical attachments from authorized stored references, bound
  selected conversation context, and include Anthropic thinking within the total
  output budget. Omitted earlier context is visibly indicated; required input
  that exceeds the budget is rejected instead of silently discarded.
- Preserve IME composition without submitting early, and avoid integer overflow
  when aggregating large usage totals.
- Correct administrative user-list thread/message counts: single-table SQL
  projections could bind the owner reference to a child identifier, displaying
  zero or another account's count. Counts now remain correlated to the listed user.

### Security

- SMTP failure no longer waives required email verification; unreadable policy
  fails closed while verified administrators retain the documented recovery path.
  Historical verification flags and sessions are not reset or treated as proof
  of mailbox ownership.
- Update Hono to 4.13.7, Nodemailer to 10.0.9, Undici to 7.29.1 and DOMPurify to
  3.4.16. Registry audits report zero known advisories as of October 1, 2026,
  without suppressions; this is not a container-OS or universal security claim.

### Changed

- Defer administration/settings routes and avoid rerendering unchanged historical
  messages during streaming. The isolated comparison reduced startup JavaScript
  transfer by about 17%; typing was already responsive, and first text was about
  50 ms slower. See the recorded evidence rather than assuming universal wins.
- Separate chat controls, lifecycle, context planning and usage reporting by
  responsibility, with regression coverage for their public behavior.
- GitHub is now the primary repository. GitHub Actions validates changes and
  publishes reviewed stable releases as API/web images on GHCR, with
  version, commit and latest tags. Existing release tags can be published by
  manual dispatch without moving them. GitLab release history remains intact.

### Upgrade and verification notes

- **Migrations 0020 and 0021 are required.** Back up and verify restore readiness,
  drain old producers, apply migrations once, and roll out a verified API/web
  pair. Do not mix old/new producers. Database/schema rollback is not implied by
  retaining old image digests; follow the recovery runbook.
- At the remediation checkpoint, 799 API tests passed on the host and Linux/arm64
  with real PostgreSQL/Redis/SMTP/S3-compatible services, plus 44 production-browser
  cases. PR CI passed linux/amd64 image builds and 793 API cases; only six S3
  cases skipped because CI lacks that service. Those six passed locally. After
  the user-count correction, the release branch passed 803 API tests on Linux
  with real PostgreSQL/Redis/SMTP/S3-compatible services and no skips. Counts
  overlap. The legacy source-built MinIO was an isolated test fixture, not an
  official release or production recommendation.
- No paid-provider, production-load or full accessibility-conformance claim is
  made. Release publication, staging and deployment remain separate gates.

## [0.4.1] - 2026-09-16

Reliability and dependency security fixes, focused internal modules, and complete
user, administrator and developer guides. No new database migrations are required
when upgrading from 0.4.0.

### Fixed

- **Concurrent responses now reserve Redis slots atomically.** Competing requests
  can no longer both observe the last available slot and exceed the configured
  cap. Retrying the same run does not consume another slot. Redis-unavailable
  behaviour remains local/fail-open.
- **Quota policy edits are all-or-nothing.** Model scope is validated before
  mutation, and policy, role and model assignments commit together. Rejected
  edits preserve the previous configuration; concurrent edits are serialized.
- **Administrator-created auditors retain their requested role** instead of
  becoming ordinary users.
- **Failed chat setup cleans up acquired resources.** Database fallback errors,
  quota refusals and SDK setup failures release owned slots and reservations and
  attempt to mark streaming placeholders failed. Once SSE capture starts, it
  alone owns run finalization. Usage settlement is still attempted if saving the
  assistant response fails, without masking the original failure.

### Security

- Updated Hono to 4.13.5, Nodemailer to 9.1.1, transitive xmldom to 0.8.15 and
  Nanoid to 3.3.18. Updated Vitest, its mocker and V8 coverage provider to 4.1.11.
- Production and full dependency audits report zero advisories as of September
  16, 2026, down from 20 production advisory entries. No findings were suppressed;
  this is a scanner result, not a guarantee of zero vulnerabilities.

### Added

- End-to-end user, administrator and developer documentation, with 37 product
  screenshots, a generated API reference, feature-development examples, and a
  fictional demo dataset and separate screenshot-capture harness.
- Regression checks for Redis contention, PostgreSQL rollback and concurrent
  policy edits, auditor creation and chat failure cleanup. Added security-boundary
  assertions for the upgraded test runner without lowering coverage thresholds.
- A repeatable signed-SAML dependency smoke that checks a valid response,
  signature tampering and malformed XML using disposable local keys.

### Changed

- Split oversized chat and administrative workflows into focused service,
  form-state and presentation modules while preserving their existing contracts.
  Removed confirmed dead exports and unused direct dependencies.
- Added an informational structural-audit command and documented maintenance
  boundaries, dependency remediation and verification limits.

### Verification limits

- Combined remediation checks passed with 312 API tests, 120 web tests and 112
  live PostgreSQL/SMTP checks. Existing coverage thresholds were retained.
- Six S3 checks remain unverified because the configured MinIO image could not
  be pulled. A staging/production deployment smoke has not yet been performed.
- The signed-SAML smoke does not replace an external IdP interoperability test.
  Existing SSO/session-control follow-ups and cookie-cache revocation behaviour
  are not changed by this release.

## [0.4.0] - 2026-08-09

Administration at scale: what an administrator can control, what they can find
out afterwards, and whether either holds up at twenty thousand accounts.

### Added

- **A read-only auditor role.** Administration was all or nothing, so a
  compliance reviewer needed write access to do a job that only requires
  reading. An auditor sees every administrative surface and can change none of
  it, enforced on the request method rather than on a hand-kept list of
  endpoints.
- **Authentication events in the audit log.** Sign-in, sign-up, sign-out,
  password reset, email change, verification, and single sign-on now record an
  outcome. Failures are recorded too, including for an account that does not
  exist, which is what makes a brute-force attempt visible. The source address
  is recorded with them; the column existed but had never been populated.
- **A user detail view**, showing counts, storage, active sessions with their
  addresses, recent conversation titles, and the audit trail for that account.
  Conversation titles only: an administrator managing an account has no reason
  to read its contents.
- **An operational health page** covering the database, Redis, providers,
  models, background jobs, email, and attachment storage. Each of these
  previously surfaced as a user complaint rather than as a status.
- **Refusing a sign-in that matches no role.** A provider can now require that
  group membership map to a role, instead of admitting everybody the identity
  provider will authenticate with a default role. Off by default, so an
  upgrade changes nothing until an administrator turns it on.
- **Profile claim mapping and direct sign-on.** Which claims carry email, name,
  picture, and subject is configurable, and a provider can take over the
  sign-in page. The local form stays reachable at `/auth/login?local=1`, which
  is the way back in if the provider fails.
- **Configurable session lifetime**, applied as each session is issued rather
  than read once at startup.
- **Bulk user actions** for roles, bans, and session revocation. An
  administrator cannot include their own account, and a ban revokes sessions in
  the same operation.
- **Saved list views**, held per person, and **scheduled usage reports**
  delivered by email.
- **Audit export and filtering.** Search, action family, and date window are
  applied in the query, with a CSV export. The log previously returned two
  hundred rows and filtered them in the browser, so retained history could not
  be reached.
- **Configuration change history.** A settings entry records what a value was
  as well as what it became. Secrets record only whether they are set.
- Administrative pages are reachable from the command palette, audit entries
  link to the accounts they name, and the overview compares activity with the
  window before it.

### Fixed

- **The user listing did not work at scale.** Counting threads and messages per
  account scanned the whole message table once per row. Measured at twenty
  thousand users and two million messages, the default listing took 2,553 ms
  and sorting by message count did not finish in sixty seconds; both are now
  5 ms and 147 ms. Migration `0017` adds the missing index.
- **Most of the directory was unreachable.** The listing accepted paging
  parameters that the interface never sent and offered no control, so it showed
  the first fifty accounts and nothing else.
- **Role mapping from single sign-on had never matched a real claim.** The
  provisioning hook was reading the OAuth token response rather than the
  identity claims, and the plugin's normalised profile carries only id, email,
  name, and image — so a claim such as `groups` was in neither. Any existing
  mapping could only have matched by accident.
- A refused single sign-on returned an error page indistinguishable from an
  outage, and left an unused session behind.
- Session expiry was displayed as though it had already passed.

### Security

- Refusing an unmatched sign-in makes group mapping an authorisation boundary
  rather than a label. Existing providers are unaffected until it is enabled.
- Settings changes redact secret values recursively, including a secret nested
  inside a configuration branch whose own name does not look like one.

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

- Roles for SSO users are recalculated from identity-provider group membership
  on every sign-in. Where a user matches several group mappings, the most
  privileged one now wins rather than whichever mapping happened to be listed
  first: row order is an authoring detail, not a privilege decision. Group
  claims are matched case-insensitively and can be read from nested attributes,
  which SAML and some OIDC providers require.

  **Some users may see their role change on their next sign-in**, in either
  direction — a user matching a more privileged mapping gains it, and one who
  has left a group loses it. Recalculation on every sign-in predates this
  release; what changed is which mapping wins. Note that a role set by hand in
  the admin interface does not survive an SSO user's next sign-in.
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

[Unreleased]: https://github.com/ncecere/open-chat-interface/compare/v0.6.1...main
[0.6.1]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.6.1
[0.6.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.6.0
[0.5.0]: https://github.com/ncecere/open-chat-interface/releases/tag/v0.5.0
[0.4.1]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.4.1
[0.4.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.4.0
[0.3.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.3.0
[0.2.1]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.2.1
[0.2.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.2.0
[0.1.0]: https://gitlab.it.ufl.edu/ict/aipe/software/open-chat-interface/-/releases/v0.1.0
