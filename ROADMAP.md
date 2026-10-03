# Roadmap

Where Open Chat Interface (OCI) stands, what comparable products offer, and
what we intend to build next. Written against **v0.6.1** and updated for
**v0.7.0**, **v0.8.0** and **v0.9.0** in **October 2026**.

This is a plan, not a promise. Priorities change as we learn, and an item moves
into a release only when it has a design, tests and documentation. Review this
document at every minor release.

- [Who OCI is for](#who-oci-is-for)
- [Where OCI stands](#where-oci-stands)
- [Principles for new features](#principles-for-new-features)
- [Shipped — v0.7: organise and find](#shipped--v07-organise-and-find)
- [Shipped — v0.8: tools and connected knowledge](#shipped--v08-tools-and-connected-knowledge)
- [Shipped — v0.9: make and operate](#shipped--v09-make-and-operate)
- [Now — v0.10: finish and harden](#now--v010-finish-and-harden)
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

## Now — v0.10: finish and harden

The gaps v0.9 left open, closed before new features. Each is small on its own;
together they make compliance, backups, exports and artifacts complete.

| Item | Gap in v0.9 | Plan |
| --- | --- | --- |
| **Legal hold covers everything** | A hold pauses conversation retention, trash purging, temporary-chat expiry, memory retention and permanent deletion, but removing a held person's project still deletes its files at once, and their usage events are still pruned. | Holds also pause project file deletion and usage-event pruning, with tests that every deletion path checks the hold. |
| **Deletions in the compliance export** | The export streams audit events and content, but not what was deleted, so a downstream archive cannot tell a deletion from a gap. | Deletions (conversations, messages, attachments, artifacts, memory) exported as events with who, what and when, never the deleted content. |
| **Backups include files** | Automated backups copy the database and list every attachment object with its checksum, but do not copy the attachments themselves; operators protect the storage separately. | Incremental attachment copies to the backup destination alongside each database backup, covered by retention and the restore check. |
| **PDF export in every script** | Exported PDFs cover Latin scripts only; Chinese, Japanese, Korean, Arabic, Hebrew and others are replaced. | Embedded fonts with wide script coverage (and right-to-left layout), chosen per document and loaded only when a document needs them, so the API image grows little. |
| **Resizable artifact panel** | The docked panel is a fixed share of the window. | A drag handle and keyboard-operable resizing, remembered in the browser. |
| **Long artifact streams after a reload** | Reloading during a very long artifact can fail to resume, because a stored reply keeps a bounded number of stream events. | Resume from the saved draft instead of replaying every event. |
| **Failed summaries are reported** | When a summary someone asked for fails in the background, the "Summarising" state simply disappears. | Tell the person it failed and why (allowance, model error), with a retry. |
| **Slow search providers** | SearchApi occasionally times out, and a slow provider fails the search. | Retry once, then fall back to a second configured provider when one is set. |
| **S3 suites in CI** | CI has no S3 (MinIO) service or PostgreSQL 17 client tools, so storage, backup and compliance-export tests skip there and their coverage floors are enforced only locally. | A MinIO service and matching `pg_dump` in CI, so those suites run on every pull request and their floors apply there too. |
| **Your shared links** | People can see a conversation's share link only from inside that conversation, so links shared long ago are easy to forget. | A Settings page listing every share link a person has made (conversation, created, expiry, view count) with Revoke and Revoke all, audited. |
| **Default model and reasoning level per person** | The composer remembers the last model per browser only, so a new device starts from the instance default. | A default model and reasoning level in Settings, stored with the account, within what the person's role allows; the instance default still applies when unset or no longer allowed. |
| **Self-service account deletion** | Settings no longer shows a Delete Account button (it never worked); administrators delete accounts under People. | An administrator setting (off by default, per role) that lets people delete their own account after typing a confirmation. Refused under legal hold; conversations, files, artifacts, memory and share links deleted, usage events kept for budgets; audited. For single sign-on accounts the next sign-in creates a new, empty account, which the confirmation explains. |
| **Clearer project search** | Keyword search cannot tell two meanings of a word apart ("plan a trip" against "data management plans"); only the optional reranker drops such passages today. | Show which passages a reply used, and let the person leave a file out of search for a question. |
| **Sidebar polish** | The remembered expanded projects do not sync between open tabs. | Sync the expanded state across tabs. |
| **Branding applied everywhere** | Branding sets the name, logo, colour theme, default theme and sign-in message, but not every surface follows it: the browser tab always says "Open Chat Interface", there is no favicon from the logo, verification and password-reset emails do not name the instance, and diagrams read an accent colour the Branding page cannot set, so they always use the default orange. | An end-to-end check of every surface (sign-in, sidebar, tab title and icon, share pages, emails, artifacts and diagrams, exports) with a browser test that sets custom branding and asserts each one, and fixes for what does not follow it. Diagram colours follow the chosen colour theme. |
| **One place for operations pages** | The Backups and Compliance pages repeat the same destination and schedule controls. | Shared components for destinations, schedules and run history. |

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
- **Multi-architecture images** (linux/arm64) for the published containers.
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
