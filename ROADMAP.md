# Roadmap

Where Open Chat Interface (OCI) stands, what comparable products offer, and
what we intend to build next. Written against **v0.6.1** and updated for
**v0.7.0** in **October 2026**.

This is a plan, not a promise. Priorities change as we learn, and an item moves
into a release only when it has a design, tests and documentation. Review this
document at every minor release.

- [Who OCI is for](#who-oci-is-for)
- [Where OCI stands](#where-oci-stands)
- [Principles for new features](#principles-for-new-features)
- [Shipped — v0.7: organise and find](#shipped--v07-organise-and-find)
- [Now — v0.8: tools and connected knowledge](#now--v08-tools-and-connected-knowledge)
- [Next — v0.9: make and operate](#next--v09-make-and-operate)
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
| User memory with controls | ✓ | ✓ | ✓ | — |
| Large project files searched instead of cut off | ◐ | ✓ | ✓ | — |
| Organisation documents searched where they live, with citations | ✓ | ◐ | ◐ | — |
| Model tool calling | ✓ | ✓ | ✓ | — |
| MCP connectors with admin governance | ✓ | ✓ | ✓ | — |
| Custom assistants / skills | ✓ | ✓ | ✓ | — |
| Artifacts / canvas | ✓ | ✓ | ✓ | — |
| Code execution / data analysis | ✓ | ✓ | ✓ | — |
| Deep research | ✓ | ◐ | ◐ | — |
| Image generation | ◐ | ✓ | ✓ | — |
| Voice input and output | ✓ | ✓ | ✓ | — |
| Side-by-side model comparison | — | ✓ | ✓ | — |
| Scheduled tasks | ✓ | ✓ | ◐ | — |
| Per-group feature and model entitlements | ✓ | ✓ | ✓ | ◐ per role (v0.7) |
| SCIM provisioning | ✓ | ✓ | — | — |
| Multi-factor authentication | ✓ | ◐ | ✓ | — |
| Compliance / eDiscovery export | ✓ | — | — | ◐ audit CSV |
| OpenTelemetry / webhooks | — | ✓ | ✓ | — |
| Interface translations | ✓ | ✓ | ✓ | — |
| Installable app (PWA) | ✓ | ✓ | ✓ | — |

The smaller gaps found while reviewing v0.6.1 (Mermaid diagrams, bulk export
and import, and switching between retried replies) shipped in v0.7. Web search
still runs one server-side query per message rather than letting the model
search; v0.8 changes that.

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

## Now — v0.8: tools and connected knowledge

Let the model act and look things up, under the same governance, and reach
institutional knowledge where it already lives.

| Item | Why | Notes |
| --- | --- | --- |
| **Tool-calling foundation** | Prerequisite for search-as-a-tool, project-file search, MCP, assistants and code execution. | A tool registry with per-role allow, an approval step for actions that change things, budget accounting for tool calls, and audit events. Show tool use in the conversation. |
| **Web search as a tool** | Today one query is run before every reply. | The model decides when and what to search, can search more than once, and cites results. The existing providers remain. |
| **Large project files** | v0.7 projects put every file in front of the model on every message, so a file that does not fit is left out and every message pays for all of them. Claude already switches to search in this situation. | Files load in full while they fit the context; beyond that, OCI searches them for the passages relevant to each message and cites file and passage. Indexed in PostgreSQL (full-text, optionally pgvector) by background jobs; embedding cost counts against budgets. The conversation shows when search is in use. |
| **MCP connectors** | The standard way to reach other systems, and where institutional knowledge comes from: documents are searched where they already live rather than copied into OCI, as ChatGPT's company knowledge and Claude's enterprise search do. | Remote MCP over Streamable HTTP with OAuth, so searches respect each person's existing permissions in systems such as SharePoint and Google Drive; answers cite the source document. Administrators allowlist servers and individual tools per role; credentials are held per person; write actions ask for approval; all calls are audited. |

## Next — v0.9: make and operate

Answers people can keep and reuse, and the operational features larger
institutions need. Artifact editing through the model builds on v0.8's tool
calling.

| Item | Why | Notes |
| --- | --- | --- |
| **Artifacts** | Documents, diagrams and small apps are easier to read, reuse and revise as objects of their own than as text in a message. | Inline first: substantial HTML, SVG, Mermaid and document blocks in a reply are saved as versioned artifacts and shown in the conversation, with a side panel (full screen on phones) to expand them. This works with every model. Once the tool-calling foundation exists, capable models also get tools to create and revise artifacts, so a change makes a new version instead of a rewrite. HTML and SVG run in a sandboxed frame with a throwaway origin and no network access, using a small set of libraries served by OCI; the same sandbox applies on share links. Documents can be edited directly; HTML and SVG are revised through the model. Artifacts are shared as part of a conversation's share link, follow its retention, count towards storage and have a per-role switch. Editorial diagrams: models draw SVG following the [Diagram Design](https://github.com/cathrynlavery/diagram-design) style guide (MIT, with attribution), mapped to the instance's colours, on by default with an administrator switch. React apps, which need a separate bundler service, are not in the first version. |
| **File output** | People need answers as documents. | Export a reply or artifact as DOCX, PDF, XLSX or PPTX, built on the stored artifacts above. |
| **User memory** | Expected from every hosted product. | Opt-in and off by default; every entry visible, editable, deletable and exportable; never used in temporary chats; per-role entitlement and retention. |
| **Long conversations** | Earlier context is dropped silently when a conversation outgrows the model. | Summarise older turns instead of dropping them, and show when it has happened. |
| **Compliance export** | eDiscovery, records requests and security monitoring. | Stream audit events and, where policy allows, conversation content as JSONL to storage or a SIEM; legal hold that pauses retention for named people. |
| **SCIM provisioning** | Large institutions provision and deprovision accounts centrally. | SCIM 2.0 users and groups; groups mapped to roles. LDAP sign-in as an optional addition. |
| **Observability and events** | Operators need metrics and integrations beyond the health page. | OpenTelemetry traces and metrics, a Prometheus endpoint, and signed webhooks for selected events. |
| **Automated backups** | Backups are documented but manual. | Scheduled `pg_dump` and attachment snapshots to S3-compatible storage, with retention and a restore check on System health. |

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
