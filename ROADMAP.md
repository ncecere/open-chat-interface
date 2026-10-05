# Roadmap

Where Open Chat Interface (OCI) stands, what comparable products offer, and
what we intend to build next. Written against **v0.6.1** and updated for
**v0.7.0**, **v0.8.0**, **v0.9.0**, **v0.10.0** and **v0.11.0** in **October 2026**.

This is a plan, not a promise. Priorities change as we learn, and an item moves
into a release only when it has a design, tests and documentation. Review this
document at every minor release.

- [Who OCI is for](#who-oci-is-for)
- [Where OCI stands](#where-oci-stands)
- [Principles for new features](#principles-for-new-features)
- [Shipped — v0.7: organise and find](#shipped--v07-organise-and-find)
- [Shipped — v0.8: tools and connected knowledge](#shipped--v08-tools-and-connected-knowledge)
- [Shipped — v0.9: make and operate](#shipped--v09-make-and-operate)
- [Shipped — v0.10: finish and harden](#shipped--v010-finish-and-harden)
- [Shipped — v0.11: always on](#shipped--v011-always-on)
- [Later — v1.0 and beyond: assistants and media](#later--v10-and-beyond-assistants-and-media)
- [Under consideration](#under-consideration)
- [Not planned](#not-planned)
- [How this was put together](#how-this-was-put-together)

## Who OCI is for

OCI is a self-hosted, multi-model chat application for institutions —
universities, research organisations and companies — that need to offer AI
chat to many people under their own identity provider, budget and policies.
The people who choose OCI care about **governance, accessibility, reliability
and control of their data** at least as much as about the newest model feature.

That shapes this roadmap. We will adopt the capabilities people now expect from
ChatGPT and Claude, but every one of them has to work with roles, budgets,
retention and the audit log — not around them.

## Where OCI stands

### What OCI does well

These are strengths worth protecting. Several are weaknesses in the
self-hosted alternatives.

- **Governance that is enforced, not just reported.** Usage budgets measured in
  messages, tokens or cost, with per-model scope, per-person overrides and
  reserve-then-settle accounting; per-role rate and storage limits; retention
  for every kind of data; a structured audit log with protected access-control
  events; scheduled usage reports; a versioned acceptable-use policy; a
  read-only auditor role. Open WebUI has no enforced quotas and its audit log is
  off-by-default request logging. LibreChat has credits but no cost analytics,
  and its audit log covers permission grants only.
- **Native OIDC and SAML** with just-in-time provisioning, domain allowlists and
  claim-to-role mapping. Open WebUI has no native SAML.
- **White-label without strings.** MIT licensed, with no contributor licence
  agreement. Open WebUI may not be rebranded above 50 users without an
  enterprise licence.
- **One operational stack.** PostgreSQL, Redis (optional) and S3-compatible
  storage. Migrations are run once under an advisory lock, readiness checks the
  schema, and a setup checklist tells administrators what is left to do.
  LibreChat needs MongoDB, Meilisearch and a separate Postgres for RAG; Open
  WebUI upgrades require every replica to move at once.
- **Reliable streaming.** Replies survive disconnects and reloads, can be
  stopped, and are reconciled against what was actually saved.
- **Accessibility as a test, not a claim.** WCAG 2.2 AA axe checks run in CI on
  desktop and mobile, with a skip link, focus management and keyboard-operable
  controls throughout.
- **An administration area organised by task**, with guided setup, a single
  Roles & access page and read-only access for auditors.

### What OCI is missing

Comparison as of October 2026. "Hosted" summarises ChatGPT, Claude and Mistral's
Vibe (formerly Le Chat): ✓ means all three offer it, ◐ means some or a partial
version. For OCI, ◐ means partial and is explained in the item below.

| Capability | Hosted | Open WebUI | LibreChat | OCI |
| --- | :---: | :---: | :---: | :---: |
| Projects / folders with instructions and files | ✓ | ✓ | ✓ | ✓ v0.7 |
| Search inside conversation content | ✓ | ✓ | ✓ | ✓ v0.7 |
| Prompt library and slash commands | ◐ | ✓ | ✓ | — |
| User memory with controls | ✓ | ✓ | ✓ | ✓ v0.9 |
| Large project files searched instead of cut off | ◐ | ✓ | ✓ | ✓ hybrid (v0.9) |
| Organisation documents searched where they live, with citations | ✓ | ◐ | ◐ | ✓ connectors (v0.8) |
| Model tool calling | ✓ | ✓ | ✓ | ✓ v0.8 |
| MCP connectors with admin governance | ✓ | ✓ | ✓ | ✓ v0.8 |
| Custom assistants / skills | ✓ | ✓ | ✓ | — |
| Artifacts / canvas | ✓ | ✓ | ✓ | ✓ v0.9 |
| Code execution / data analysis | ✓ | ✓ | ✓ | — |
| Deep research | ✓ | ◐ | ◐ | — |
| Image generation | ◐ | ✓ | ✓ | — |
| Voice input and output | ✓ | ✓ | ✓ | — |
| Side-by-side model comparison | — | ✓ | ✓ | — |
| Scheduled tasks | ✓ | ✓ | ◐ | — |
| Per-group feature and model entitlements | ✓ | ✓ | ✓ | ◐ per role (v0.7) |
| SCIM provisioning | ✓ | ✓ | — | — |
| Multi-factor authentication | ✓ | ◐ | ✓ | — |
| Compliance / eDiscovery export | ✓ | — | — | ✓ v0.9 |
| OpenTelemetry / webhooks | — | ✓ | ✓ | ✓ v0.9 |
| Interface translations | ✓ | ✓ | ✓ | — |
| Installable app (PWA) | ✓ | ✓ | ✓ | — |

The smaller gaps found while reviewing v0.6.1 (Mermaid diagrams, bulk export
and import, and switching between retried replies) shipped in v0.7, and web
search became a tool the model uses when it chooses in v0.8.

## Principles for new features

1. **Governance travels with the feature.** Every new capability has a per-role
   entitlement on Roles & access, counts against budgets where it costs money,
   writes audit events, and follows retention. A feature that cannot be
   governed is not ready.
2. **Provider-neutral, capability-aware.** Build on the AI SDK; light features
   up only for models whose catalog capabilities support them, and degrade
   clearly otherwise. Catalog capability tags should change behaviour, not just
   label models.
3. **Extend out of process.** Integrations run through MCP or OpenAPI services
   that administrators review and allowlist. OCI will not run arbitrary
   third-party code inside the API process.
4. **Keep one stack.** Prefer PostgreSQL extensions (pgvector, full-text
   search) and the existing job runner over new mandatory services. Anything
   that needs isolation, such as code execution, is an optional add-on.
5. **Accessible and honest by default.** New screens ship with axe coverage and
   keyboard tests, and documentation describes what the code does.
6. **Private unless chosen otherwise.** Memory, sharing and connectors start
   off for institutions and are visible and reversible for the person they
   affect.

## Shipped — v0.7: organise and find

Released as v0.7.0 in October 2026. See `CHANGELOG.md` for the details and
upgrade notes.

| Item | What shipped | Left for later |
| --- | --- | --- |
| **Documentation corrections** | The web search and sharing guides describe what the code does; the search guide was corrected when search shipped. | — |
| **Feature entitlements per role** | Per-role switches for web search, attachments, share links, temporary chats, branching and projects, and allowed reasoning levels, all enforced by the server; an instance default reasoning level. | Groups and custom roles (see Later). |
| **Full-text conversation search** | Titles and message text, prefix matching, ranked results with highlighted snippets, and jump-to-message. | No stemming or language-specific matching; no paging beyond 50 results. |
| **Projects** | Instructions and up to 20 files per project, added to every conversation in it within the context budget; per-role switch; included in the full export. | Large files are left out when they do not fit (v0.8); shared projects (Later). |
| **Rendering and reading** | Mermaid diagrams in an editorial style after Diagram Design; wrapping long code lines; a switcher between retried replies, which also fixed retries sending both replies to the model. | Switching earlier turns; editing an earlier message still starts a new conversation. |
| **Data portability** | Export of every conversation as a zip (Markdown, JSON and files), and background import of ChatGPT and Claude exports. | ChatGPT attachment files, Claude projects, and other branches are not imported. |

## Shipped — v0.8: tools and connected knowledge

Released as v0.8.0 in October 2026. See `CHANGELOG.md` for the details and
upgrade notes, and `docs/dev/tools-design.md` for the design.

| Item | What shipped | Left for later |
| --- | --- | --- |
| **Tool-calling foundation** | Tools offered to models tagged for tool calling, per-role tool switches, a step limit that still ends with an answer, approval for tools that change things, metadata-only audit, and tool steps in the conversation, shares and exports. | A "connect your account" hint in the composer. |
| **Web search as a tool** | The model decides when and what to search and cites results; SerpApi and SearchApi join the providers; the Web search page asks only for what a provider needs and can test it. | Retrying or falling back when a provider is slow. |
| **Large project files** | Passages indexed with PostgreSQL keyword search; large projects send the best-matching passages instead of leaving files out. | Meaning-based (hybrid) search, below. |
| **MCP connectors** | Remote MCP servers with no authentication, a shared credential or per-person OAuth; read and write tools allowed per role; guarded outbound requests. | Reusing connections, coordinating token refresh across replicas, older MCP transports. |

## Shipped — v0.9: make and operate

Released as v0.9.0 in October 2026. See `CHANGELOG.md` for the details and
upgrade notes, and `docs/dev/v0.9-design.md` for the design.

| Item | What shipped | Left for later |
| --- | --- | --- |
| **Meaning-based search for project files** | Optional hybrid search (keyword plus pgvector, merged) when an embeddings model is configured, optional Cohere-compatible reranking, and relevance floors so unrelated questions add no passages. | Conversation search and large chat attachments on the same embeddings; per-model floors. |
| **Artifacts** | Versioned HTML, SVG, Mermaid and document artifacts from replies and tools, written live into a docked panel that opens by itself on wide screens, with full screen, versions, highlighted source and a sandboxed preview, also on share links. | A resizable panel and resuming very long streams (v0.10); React apps. |
| **File output** | DOCX, PDF, XLSX and PPTX from replies and documents. | PDFs in non-Latin scripts (v0.10). |
| **User memory** | Opt-in at instance, role and person level, visible, editable, exported and never used in temporary chats. | — |
| **Long conversations** | Background summaries after the approach of the pi coding agent; nothing deleted, nothing waits. | Reporting a failed summary (v0.10). |
| **Compliance export** | Audit events and optional content as verified JSON Lines to S3, and legal holds. | Holds covering project files and usage events; deletions as events (v0.10). |
| **Observability and events** | Prometheus metrics, OpenTelemetry traces and signed webhooks. | — |
| **Automated backups** | Verified, scheduled `pg_dump` to S3 with retention and an attachment manifest. | Copying attachments (v0.10). |

## Shipped — v0.10: finish and harden

Released as v0.10.0 in October 2026. See `CHANGELOG.md` for the details and
upgrade notes, and `docs/dev/v0.10-design.md` for the design.

| Item | What shipped | Left for later |
| --- | --- | --- |
| **Fixes found writing the documentation site** | Delete user in People, the listed shortcuts, renaming conversations, per-model context and output limits, Compose's initial administrator, corrected guides, and one trusted client address (also shipped as v0.9.2). | — |
| **Legal hold covers everything** | Every deletion path checks holds, with a test that fails on any unlisted deletion. | Edits (renames, memory text) are not held; backup retention still deletes old backups. |
| **Deletions in the compliance export** | Every deletion writes an audit entry (never content), carried by the exactly-once export. | — |
| **Backups include files** | Incremental, checksummed copies of attachments, thumbnails and the logo, swept after retention, with a restore script. | A same-bucket copy shortcut; a database-side sweep list for very large instances. |
| **PDF export in every script** | Noto fonts per run of text, Arabic and Hebrew shaped and right to left. | Colour emoji; italic for CJK, Arabic and Hebrew. |
| **Artifacts and summaries** | A resizable panel, long replies resuming after a reload, failed summaries reported. | A per-account panel width. |
| **Slow search providers** | Retry, then a fallback provider. | — |
| **Clearer project search** | The passages a reply used, and leaving files out of a message. | Leaving files out of a new conversation's first message; headings stored at indexing. |
| **People's settings** | Your shared links, a default model and reasoning level, self-service account deletion behind a per-role switch, usage kept anonymised after deletion. | — |
| **Branding applied everywhere** | The OCI logo as the default mark, titles, icons, share pages, emails, diagrams and exports. | Link previews for share pages (needs server-rendered HTML); a web app manifest. |
| **S3 suites in CI, operations pages, sidebar sync** | S3, backup and compliance suites run in CI on VersityGW; shared operations components; expanded projects synced across tabs. | — |

## Shipped — v0.11: always on

Large deployments (tens of thousands of people, tens of millions of messages,
a highly available PostgreSQL cluster such as Patroni) cannot take hours of
downtime for an upgrade. In comparable products those hours go to database
migrations that rewrite large tables, rebuilding vector indexes and
re-indexing. The goal of v0.11 is that upgrading from the previous minor
release needs **no downtime**, survives a database failover partway through,
and that this is tested, not promised.

OCI starts from a good place: migrations run once under a lock, releases keep
the previous version working against the new schema, messages are rows rather
than one document per conversation, vectors live in PostgreSQL, and indexing
and embedding already run as background jobs. What is missing is below.

| Item | Why | Plan |
| --- | --- | --- |
| **Two-phase migrations** | Migrations run in one transaction, so an index on a large table cannot be built concurrently and blocks writes while it builds, and data changes inside migrations take time proportional to the table. | After [GitLab's model](https://docs.gitlab.com/development/database/): a fast transactional schema step before the deploy, then post-deploy steps and batched background migrations run by the job runner while OCI serves (concurrent index builds, backfills in small batches with pauses, invalid indexes cleaned up and retried). Progress on System health; features that need a step degrade gracefully until it finishes; a release can require earlier background migrations to be complete before it upgrades. |
| **Lock-safe migrations** | A migration waiting behind one long query queues every request behind it, so even a fast change can freeze the application. | Short lock and statement timeouts on every migration step, with automatic retry and backoff. |
| **Failover-safe upgrades and jobs** | On a highly available cluster the primary can change during an upgrade, dropping connections and the advisory locks that guard migrations and jobs. | Migrations and background migrations resume cleanly after a failover; jobs re-acquire their locks; requests retry where it is safe. A failover drill (stopping the primary mid-upgrade and mid-backfill) runs in the test suite. |
| **Migration linter** | Unsafe changes are easy to write and only show at scale. | CI blocks non-concurrent indexes on existing tables, table rewrites, unbatched data updates, `NOT NULL` without a default, and dropping a column the previous release still reads. |
| **Rolling-upgrade tests** | "The previous release works against the new schema" is a convention today. | Every release upgrades a seeded database from the previous minor while the previous release serves traffic, and runs the previous release's checks against the new schema. Supported upgrade paths are published, including which releases cannot be skipped. |
| **Upgrade preflight** | Operators cannot see what an upgrade will cost before starting it. | A command and an administration page listing pending migrations and background migrations with estimated work (table sizes, index builds, disk needed), and whether this upgrade can be rolling. |
| **Vector and search rebuilds without a gap** | Changing the embeddings model, or a search index, must not leave search empty while it rebuilds. | A new embeddings model or index builds alongside the current one and takes over when complete; the old one is removed afterwards. Never inside a migration. |
| **Read-only maintenance mode** | For the rare change that cannot be online, down is the wrong fallback. | People can read and search while sending pauses, announced ahead with a scheduled banner. |
| **Scale test harness** | OCI has not been measured at tens of thousands of people and tens of millions of messages. | A synthetic dataset at that size and a repeatable run that measures upgrade and migration time, page and search latency and job throughput before each release, with results published in the release notes. |
| **Connection pooling** | OCI needs direct or session-mode connections, and many replicas against one cluster run out of them. | Transaction-mode pooling (PgBouncer) for ordinary queries, with a small direct pool for locks and jobs. Optional routing of heavy reads (search, reports, exports) to replicas. |
| **Images for arm64** | Release images are published for linux/amd64 only. | linux/arm64 images alongside amd64, built and tested in CI. |
| **Kubernetes Helm chart** | The zero-downtime procedure should be the default, not a runbook. | A first-party chart: migration job before the rollout, rolling updates, disruption budgets, readiness gating and autoscaling on OCI's metrics. |
| **Draining replies on shutdown** | A replica that stops ends the replies it is writing, so every rolling upgrade cuts some off. | On shutdown a replica stops taking new turns, lets replies in progress finish within a limit, and saves anything left so it can continue elsewhere. |
| **Separate worker role** | Embedding, imports, document rendering, exports and backups run on the same replicas as requests. | An optional worker role that runs background work and scales separately. |
| **Provider capacity** | At scale the model provider's rate limits are the bottleneck, and requests over them fail. | Shared per-provider and per-model limits across replicas, a fair queue with a visible position, and backoff on rate-limit errors. |
| **Redis high availability** | Several replicas depend on Redis for reply streams and shared limits. | Sentinel and Redis Cluster support, documented behaviour when Redis is unavailable, and a tested failover. |
| **Optional Qdrant** | Very large deployments may want vector search off the database cluster. | A vector store interface with pgvector as the default; Qdrant as an optional, rebuildable store (PostgreSQL stays the source of truth, blue/green collections, reliable deletes), if the scale harness shows the need. |
| **Backups at scale** | `pg_dump` takes hours on a large cluster. | For clusters with their own backups (pgBackRest, WAL-G), OCI backs up attachments and verifies; recovery objectives and restore drills documented. |
| **Fast usage reports and budgets** | Budgets and the Usage pages read raw usage events. | Hourly and daily rollups maintained in the background. |
| **Background work visible** | Imports, indexing, re-embedding and background migrations run out of sight. | Queue depth, progress and failures on System health and in metrics. |

**Shipped in v0.11.0.** Everything above except two items: **Backups at
scale** moves to the next release, and **Optional Qdrant** is not needed for
now: measured at 437,000 passages, an exact pgvector scan within one project
takes about 20 ms, so v0.11 ships the vector store interface and generations
and Qdrant waits for a deployment that needs it. **Background work visible**
shipped as System health → Background work and Upgrades, with job health and
queue metrics. The scale harness reordered the rest (usage rollups came
early) and found fixes along the way: project search 773 to 180 ms, the admin
overview 126 to 22 ms, usage pages 777 to 39 ms. What each item became is in
the "As built" notes of `docs/dev/v0.11-design.md`.

Further items (cross-replica cache invalidation, batched pruning, loading
long conversations in parts, sign-in storms, encryption key rotation, service
objectives) and the design are in `docs/dev/v0.11-design.md`. Measured by the
harness, later releases may also partition the largest append-only tables
(usage events, audit log, webhook deliveries) so that retention drops old
partitions instead of deleting rows.

## Later — v1.0 and beyond: assistants and media

| Item | Why | Notes |
| --- | --- | --- |
| **Assistants** | Packages of instructions, knowledge and tools are how hosted products now let teams share expertise; custom GPTs are being replaced by skills and plugins. | A model plus instructions, files and allowlisted tools (including knowledge connectors), shared by role or group. Published assistants go through administrator review. |
| **Code execution** | Data analysis on spreadsheets and CSVs, charts and generated files. | An optional, isolated sandbox service with time, memory and network limits; outputs saved as attachments; per-role entitlement and budget. |
| **Deep research** | Multi-step, cited reports. | Built on web search and connector tools, with a visible plan, the ability to steer, a budget cap per run and export. |
| **Image generation** | Requested for teaching material and communications. | Through provider APIs (OpenAI, Google), priced per image in budgets, with per-role entitlement and the acceptable-use policy applied. |
| **Voice** | Dictation and read-aloud help accessibility as much as convenience. | Speech-to-text dictation and text-to-speech playback first; real-time voice later. |
| **Model comparison** | Helps people choose models, and helps administrators curate the catalog. | Send one prompt to two models side by side and record which answer was preferred, reported on Usage. |
| **Groups and finer roles** | Departments need their own limits, prompts and assistants. | Groups alongside roles, custom roles, and delegated administrators who manage one group. Shared projects with view and edit permissions. |
| **Data classification** | Institutions must keep sensitive data (for example student or health records) away from unapproved models and connectors. | Label models and connectors with the data classes they are approved for; warn or block when a conversation crosses them. |
| **Scheduled prompts** | Recurring summaries and checks. | A prompt that runs on a schedule with the owner's permissions and budget, delivering by email or notification. |
| **Interface translations** | Institutions serve people in many languages. | Translation framework and right-to-left support first; translations contributed per language. |
| **Prompt library** | Saves retyping and spreads good practice. | Personal and administrator-published prompts with `{{variables}}`, inserted with `/`, optionally limited to roles. |
| **Multi-factor authentication** | Protects local accounts, including the break-glass administrator. Most institutions sign in through single sign-on, where the identity provider already enforces MFA. | TOTP and passkeys through Better Auth, with an option to require MFA per role. |
| **Installable app** | Phones are where many people use chat. | Web manifest and icons; no offline mode. |
| **Accessibility conformance report** | Procurement at public institutions asks for one. | A published VPAT/ACR backed by a manual WCAG 2.2 AA audit, not only automated checks. |

## Under consideration

Ideas with merit that need more evidence or design before they are scheduled.

- **Bring your own key** for individuals, alongside institution-funded models.
- **Multiple organisations** in one deployment. The schema has an organisation
  table, but there is no tenant model in the product.
- **Moderation** of prompts and replies against institutional policy, beyond
  rate limits and the acceptable-use policy.
- **Native PDF input** to models that support it, instead of always extracting
  text.
- **Changing your own email address.** For single sign-on accounts the
  identity provider owns the address, and OCI uses it to link sign-ins to
  accounts and to check domain allowlists, so a change in OCI could split an
  account in two or, without strict verification, let one person claim
  another's institutional address. For password accounts it would need a
  confirmation sent to the new address and a notice to the old one.
  Administrators cannot change addresses either today; a person whose address
  changes signs in with the new one (single sign-on) or is invited again.
- **SCIM provisioning** (SCIM 2.0 users and groups mapped to roles, with LDAP
  sign-in as an optional addition). Large institutions provision accounts
  centrally, but single sign-on with just-in-time provisioning and claim-to-role
  mapping covers sign-up today; deprovisioning is the main gap.

## Not planned

- **In-process plugins that run arbitrary code.** Extensions go through MCP or
  OpenAPI services instead (see principle 3).
- **Browser and computer-use agents.** The risk to institutional accounts is
  hard to govern today; revisit once tool approval and audit are proven.
- **Group chats and channels.** ChatGPT has stopped creating new group chats,
  and shared projects cover most collaborative use.
- **A programmatic API with personal or service keys.** OCI is a chat
  interface; integrations that need model access should go through a model
  gateway such as LiteLLM.
- **Knowledge bases managed inside OCI.** Institutional documents are searched
  where they already live, through connectors that respect each person's
  permissions, instead of being uploaded, synced and governed as a second copy.
  Project files cover personal reference material.
- **Artifacts that call models themselves** (Claude's AI-powered apps). They
  bypass the conversation's budget and review; revisit once tool approval and
  audit are proven.
- **Consumer billing and payments.** Institutions fund usage; budgets and
  reports cover allocation.

## How this was put together

- **OCI:** a feature inventory of v0.6.1 verified against the code, not only
  the documentation, updated after the v0.7.0 release.
- **Hosted products:** the official help centres, release notes and
  documentation of ChatGPT (OpenAI), Claude (Anthropic) and Vibe, formerly
  Le Chat (Mistral), read in late September 2026. Some OpenAI help pages could
  only be read through search excerpts.
- **Self-hosted products:** the documentation, changelogs, licences and issue
  trackers of Open WebUI (v0.11.4) and LibreChat (v0.8.8).

Products in this space change monthly. Treat the comparison table as a snapshot
and re-check it before relying on any single cell.
