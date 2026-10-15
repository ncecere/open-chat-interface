# Spec: data-classification

Module of [SPEC.md](SPEC.md) (v0.14). Depends on nothing. Shared commands, structure, style, testing and
boundaries are in SPEC.md; this file adds what is specific to this module. Migration `0052` is reserved for it.
Status: **approved 2026-10-14: every recommendation in "Open questions" and every decision under "Decisions (mine, for review)" is accepted.** Line numbers are from `main` at v0.13.1 (branch `v0.14/spec`).

## Objective

Let an institution say which models and connectors may handle which kinds of data, and have OCI refuse (or warn)
when labelled content would reach one that is not approved. Closes #395.

**Today (v0.13.1):** nothing connects a conversation to what it contains. A person can pick any model their role
sees (`resolveModelForRole`, `services/models.ts:105`), and any enabled connector tool is offered whatever the
conversation holds (`resolveTurnTools`, `services/tools/registry.ts:38`). Content reaches providers and third
parties at the places listed under [Enforcement points](#enforcement-points).

**Users:** people who chat and label; administrators who define classes and approvals; institutions with
data-handling duties (student records, health data) that must show the control worked.

**Decided (SPEC.md decision 3, not reopened):** classes are admin-defined **names**, not a ranked scale. **Deny by
default:** with the feature on, a model approved for no class cannot receive labelled content; an unlabelled
conversation is unaffected, so switching the feature on changes nothing until something is labelled. Instance
modes: `off` (default), `warn`, `block`. A conversation's classes come from its project's labels, the connectors
whose tools it has used (sticky), and labels the person adds.

**Principle I added:** a label is never lost as a side effect of something else (moving a conversation out of a
project, deleting a project or connector, forking). It is lost only when someone entitled to declare changes the
declaration, and that is audited.

## Data model (migration `0052`, additive, one file)

Join tables, not arrays: a deleted or renamed class must not leave dangling ids (an array cannot enforce that, and
`visible_to_roles`-style arrays would make "which models are approved for X" and "is X in use" unanswerable
without scanning). Names live only in `data_class`; everything else holds ids, so a rename touches one row.

| Table | Columns (besides ids/timestamps) | Notes |
|---|---|---|
| `data_class` | `organization_id`, `name` (1-60), `description` (<=280), `retired_at` | unique `(organization_id, lower(name))`; retired classes stay enforced |
| `model_data_class` | `model_id` -> `model` cascade, `data_class_id` -> class cascade | the **approvals**; PK both |
| `connector_data_class` | `connector_id` cascade, `data_class_id` **restrict** | what the connector **carries** |
| `project_data_class` | `project_id` cascade, `data_class_id` restrict, `locked`, `created_by` | `locked` = set by an admin; only an admin removes it |
| `thread_data_class` | `thread_id` cascade, `data_class_id` restrict, `source` (`person`\|`kept`), `origin` text, `created_by` set null | PK `(thread, class, source)`; `kept` rows are frozen labels (below) and not removable by the person |
| `thread_connector_use` | `thread_id` cascade, `connector_id` cascade, `first_used_at` | the sticky fact; classes are read from the connector **at resolution time** |
| `connector.data_classes_reviewed_at` | nullable `timestamptz` | no default, no rewrite |

Indexes on `data_class_id` of the four label tables (needed for the `restrict` checks and usage counts). All in
the migration that creates the tables, so the linter allows plain `CREATE INDEX`.

**Why `thread_connector_use` and not a copy of the classes:** if an administrator classifies a connector in week
5, conversations that used it in week 1 hold its data and must become labelled; a copy made at tool time would
miss them. Recording the *use* always (even in mode `off`; one `insert ... on conflict do nothing`, invisible)
makes that retroactive. Uses before 0052 are found by background migration `0.14.thread-connector-use` (below).

**Triggers (so every writer is covered, including v0.13 replicas mid-upgrade; precedent: 0048):**
1. `BEFORE UPDATE OF project_id ON thread`, when the old value is not null and differs: freeze the old project's
   classes as `kept` rows (`origin` = `project`). Covers "Move" (`moveThreadToProject`, `services/projects.ts:437`).
2. `BEFORE DELETE ON project`: freeze its classes onto every thread in it. It must be `BEFORE`: the
   `ON DELETE SET NULL` on `thread.project_id` and the cascade to `project_data_class` are both AFTER triggers
   with no guaranteed order (`deleteProject`, `services/projects.ts:277`).
3. `BEFORE DELETE ON connector`: freeze the connector's classes onto threads in `thread_connector_use`
   (`origin` = `connector: <name>`), since the use rows cascade away.
4. `AFTER INSERT ON thread WHEN parent_thread_id IS NOT NULL`: copy the parent's `thread_data_class` and
   `thread_connector_use` rows. Forks and edit-branches (`forkFromMessage` `services/threads.ts:302`,
   `branchFromUserMessage` `:389`, which keep the project) are covered without touching either function.

**Defaults for new records:** a model is approved for nothing; a connector carries nothing and has
`data_classes_reviewed_at` null; a project and a thread carry nothing. With the mode on, creating a connector
requires saying which classes it carries *or* that it carries none (422 otherwise), and the admin page shows
"Not reviewed" on every connector whose timestamp is null. This closes the main fail-open: an unlabelled connector
is unaffected by decision, so forgetting to label it must be visible.

**Class lifecycle.** *Rename:* updates the name; ids are stable; audit records both names. *Retire:* hides it from
pickers and refuses new labels; existing labels and approvals still count. *Delete:* only when no project,
thread or connector references it (409 with counts, via the `restrict` keys); approvals cascade. There is no
"force delete": it would unlabel content silently.

**Settings (no migration):** `instance_setting` key `classification` =
`{ mode, services: { webSearch: classIds[], embeddings: classIds[], reranking: classIds[] } }`. A v0.13 replica
ignores an unknown key. Absent = `off`, no approvals.

## Resolution

`resolveClassification({ threadId | projectId, destination, extraClassIds? })` in
`apps/api/src/services/classification/resolve.ts`. It takes the model **slug**, not the `ResolvedModel` (existing
live suites mock `resolveModelForRole` and return no ids, e.g. `connectors-tools.live.test.ts`).

1. Read the mode (`getSetting`, cached; Redis invalidation is immediate, otherwise <= 30 s). `off` returns
   `allow` with no further reads.
2. **Classes C** = project labels (via `thread.project_id`) union classes of every connector in
   `thread_connector_use` (current classes) union `thread_data_class` rows union `extraClassIds`. One query;
   each class carries its reasons (project, connector, person, kept) for the UI. While
   `isBackgroundMigrationDone('0.14.thread-connector-use')` is false, add a fourth branch that scans *this
   thread's* messages for connector tool parts (`isToolPart`/`toolIdOfPart`, `packages/shared/src/tools.ts:214`),
   the "code during the gap" pattern of `docs/dev/database.md`.
3. **Approved set A** by destination: model -> `model_data_class` of the slug; service ->
   `classification.services[name]`; share link -> always empty.
4. `missing = C \ A`. Empty (including C empty) -> `allow`. Otherwise `block` in mode `block`, `warn` in `warn`.
5. Errors: in `block` any failure to read refuses (fail closed; reads sit inside `retryTurnStep` so a failover is
   retried first); in `warn` it allows and logs.

| Conversation classes | Model approved for | Mode | Result |
|---|---|---|---|
| none | anything | warn/block | allow, no query beyond the class read |
| any | any | off | allow, no query |
| {Student} | {Student, Health} | block | allow |
| {Student, Health} | {Student} | block | block, missing {Health} |
| {Student} | {} (new model) | block | block (deny by default) |
| {Student} | {} | warn | allow with warning, audited |
| {Student} (retired) | {} | block | block (retired still counts) |
| {Student} via a deleted connector (`kept`) | {} | block | block |
| {Student} from `extra` (connector tool about to run) | {Student} | block | allow, then the use row is written |

Labels are **not retroactive for sends already made**: a conversation labelled after it went to an unapproved
model is blocked from its next send, not recalled. A send racing a label commit may pass once; the label
endpoints take `lockChatThread` (`services/chat/thread-claim.ts`) so they serialise with the claim.

## Enforcement points

Every place found in the code where content reaches a model or leaves OCI. "Gate" = `resolveClassification`.

| # | Place (evidence) | What leaves | Decision |
|---|---|---|---|
| a | **Send** `resolveTurnContext` (`chat/turn-context.ts:34-55`) after `resolveModelForRole` (:41), before `acquireRun` (`chat/setup-turn.ts:21`); retry/regenerate use the same route | prompt, history, files, project instructions and passages, memories, summary | **In.** Gate with the chosen slug. Block throws before anything is stored, so `X-OCI-Message-Saved: no` is set by `errorHandler` (`turn-patience.ts`) and the text returns to the box |
| b | **Connector tool run** `buildSdkTools` -> `definition.execute` (`tools/registry.ts:112,148`); offered by `resolveTurnTools` (:38-70) | tool arguments written by the model; the result then enters the conversation | **In, two layers.** *Offer:* in `block`, a connector tool whose classes are not all approved for the active model is not offered (the model never sees it). *Execute:* the guard resolves with `extraClassIds` = the connector's classes **before** `execute`; on block it throws `ToolFailure('This tool is not available in this conversation.')` (the wording at `chat/tool-loop.ts:54`, so the model is told the tool is unavailable and no class name reaches the provider), audits `tool.call` outcome `refused` plus `classification.block`, and never calls `callConnectorTool` (`connectors/tools.ts`). On allow it writes the use row **first**, then runs (a crash after the call still leaves the label). In `warn` it runs and notes it. `ToolCaller` (`tools/types.ts`) gains `modelSlug` |
| c | **Approval continuation** `setupApprovalContinuation` (`chat/approvals.ts:113`): the reply's own model, tools re-resolved (:114) | the continued turn and an approved write tool | **In.** Gate before the claim transaction (~:150), so a block leaves the reply waiting. Labels may have changed since the call was requested |
| d | **Model switch** | nothing until the next send | **In (UI and send).** The picker shows unapproved models disabled with the missing class names; the server still gates (a) |
| e | **Compaction** `runClaimed` (`chat/compaction-queue.ts:382`) -> `generateText` (`chat/compaction-summary.ts:111`); manual `POST /:id/compact` (`routes/threads.ts:357-370`) | the transcript of earlier turns plus any typed instructions | **In.** Gate in `compactConversation` (`compaction.ts:54`) and, for fast feedback, in `assertCompactionPossible` (:112). Manual block: 403 `DATA_CLASS_BLOCKED`. Automatic block: the job ends quietly and `scheduleAutomaticCompaction` is not retried; audited. A stored summary inherits the thread's classes (it is not separately labelled) |
| f | **Web search, tool** `webSearchTool.execute` (`tools/web-search.ts:52-55`) | a query the model wrote from the conversation, to Brave/Tavily/etc. | **In.** Destination `webSearch`: approved only if the class is in `services.webSearch`. Block: not offered, guard refuses as in b |
| g | **Web search, up-front** for models without tool calling (`chat/model-context.ts:139-145`: `normalizeSearchQuery(textFromParts(latest))`) | the **whole latest message** (<= 2,000 characters) to the search provider | **In.** Same destination. Block: the search is skipped and the reply says so (the existing failure note path, `searchOrFailure`, :65) |
| h | **Memory write** `rememberTool.execute` (`memory/tools.ts:81`); memories are injected into *every* non-temporary conversation (`loadMemorySection`, `chat/model-context.ts:159`) | labelled content could be copied into a note that later reaches an unapproved model | **In.** In any conversation with classes (`warn` and `block`), `remember` is not offered and refuses if called. `forget` and manual notes are unaffected. Memory read into a labelled conversation is fine: notes are the person's own and cannot carry that conversation's content |
| i | **Project passages: query embedding** `semanticProjectChunks` -> `embedValues` (`project-search/semantic.ts:104`), called at `chat/project-context.ts:333` | the latest message to the embeddings provider | **In.** Destination `embeddings`. Block: skip the meaning-based side, keyword search only (the path used when embeddings fail, `semantic.ts:~118`); the reply's project note says so |
| j | **Project passages: reranking** `rerankProjectCandidates` (`project-search/rerank.ts:44-57`, called at `project-context.ts:342`) | the message and candidate passages to the reranker | **In.** Destination `reranking`. Block: keep the fused order (`reranked: false`) |
| k | **Project file embedding** `embedFilePassages` (`project-search/embedding.ts:71`, reached from the job, `fillGeneration` and `embedUploadedProjectFile` :264) | file passages to the embeddings provider, with no conversation involved | **In, by project labels.** Passages of a project whose classes are not all in `services.embeddings` are not embedded. The filter goes in `pendingPassages` (`vector-store/pgvector.ts:355`) so skipped files cannot fill the 512-passage page and starve others, and again at the top of `embedFilePassages` for races. Existing vectors stay (they are in our database); a later label does not recall past calls |
| l | **Share links** `createShareLink` (`services/share-links.ts:68`), public read `getPublicShare` (:420) | the whole conversation to anyone with the link | **In.** Never approved. `block`: create refused (403 `DATA_CLASS_BLOCKED`); an existing link of a labelled conversation answers 404 while labelled (pausing, not revoking; no class is disclosed to anonymous readers); the owner's list shows it as paused. `warn`: allowed with a notice and audit |
| m | **Title** `deriveTitle` (`threads.ts:523`) | nothing: a string cut of the first message, no model | **Out.** No call exists. If a title model is ever added it must go through the gate |
| n | **Thread/message export** (`routes/threads.ts:225,249`), full export (`routes/portability.ts:56`) | an archive to the same signed-in person | **Out.** The person's own data to the person. Labels are not added to exports in 0052 (open question 6) |
| o | **Compliance export** (`compliance/export-lines.ts`, `content.ts`) | audit events and (opt-in) message text to the institution's own bucket | **Out.** An administrator-controlled archive. It carries `classification.*` audit events automatically (`auditLines`) |
| p | **Webhooks, logs, metrics, traces** | audit metadata, ids | **Out, with a rule:** no content, titles or class names in logs, spans or metric labels; class names may appear in audit metadata (and so in webhooks) |
| q | **Attachment text extraction** (`attachments/extract.ts`, local `unpdf`) | none; I saw no network call | **Out** |
| r | **Overflow rebuild**, capacity-queue handoff, reply switching | same model, same content | **Out** (covered by a) |

Not controlled, said plainly in the docs: copying text into another conversation, screenshots, downloads, and
**the arguments a labelled conversation sends to an unlabelled connector** (row b only checks the connector's data
coming *in*; open question 1). Classification governs OCI's own paths; it is not data-loss prevention, and an
approval is the administrator's statement about a provider, not something OCI can verify.

## Refusals and messages

OCI's refusals are `AppError` -> `{ error: { code, message, details } }` (`lib/errors.ts`, `middleware/error-handler.ts:29`);
a model refusal today is `forbidden(...)` 403 (`services/models.ts:112,115`). Add code `DATA_CLASS_BLOCKED`
(403) to `ERROR_CODES` (`packages/shared/src/errors.ts`):

```json
{ "error": { "code": "DATA_CLASS_BLOCKED", "message": "Your message was not sent. Claude Sonnet is not approved for Student records, which this conversation carries. Choose a model that is approved for them.",
  "details": { "point": "send", "model": {"slug":"..","displayName":".."},
               "missing": [{"id":"..","name":"Student records","reasons":["project","connector"]}],
               "approvedModels": [{"slug":"..","displayName":".."}] } } }
```

`message` is plain and complete, so an old or generic client shows it (`chatErrorText`, `apps/web/src/lib/api-client.ts:~72`,
already surfaces `error.message`); the web app also reads `details` to offer the approved models. `point` is
`send | approval | compaction | share`. Tool refusals use the existing tool-error text, not this body. `warn`
returns no error: the reply carries a `data-classification` part (`{ mode: 'warn', point, model, missing: names }`)
rendered like `data-project-search`, written next to `searchGroundingPart` in `stream-response.ts`.

## API

- User: `GET /api/classification?threadId=|projectId=` returns `{ mode, classes: [{id,name,reasons}], models: [{slug, status: ok|warn|blocked, missing}] }`, server-computed so the client does no set arithmetic.
  `PUT /api/projects/:id/data-classes` (owner; admin-locked labels cannot be removed). `POST /api/threads/:id/data-classes {classId}`
  and `DELETE .../:classId` (owner; only `person` rows are removable, else 409). `GET /api/data-classes` (non-retired names). `ThreadSummary` (`serializeThread`, `thread-summary.ts:9`) gains `dataClasses`.
- Admin (`requireAdmin`; auditors read, as for connectors): `GET/POST/PATCH/DELETE /api/admin/data-classes`, `POST .../:id/retire`;
  `PUT /api/admin/models/:id/data-classes`; `PUT /api/admin/connectors/:id/data-classes {classIds, reviewed}`;
  `GET/PATCH /api/admin/classification` (mode and service approvals); `PUT /api/admin/projects/:id/data-classes` (sets `locked`).
  `AdminModel` (`routes/admin/models.ts:30`) gains `dataClassIds`; the connector DTO gains `dataClassIds` and `reviewed`.
- Setting the mode to `warn` or `block` is refused (409) until a row for `0.14.thread-connector-use` exists in
  `background_migration` (it is scheduled only by `migrate --post`, after every replica runs 0.14), see
  [Rolling upgrade](#rolling-upgrade).

## Admin UI

New page **Data classes** beside Models and Connectors (`apps/web/src/lib/admin-navigation.ts`): the mode
(Off / Warn / Block, with one sentence each, and a banner while the upgrade is unfinished or the backfill runs);
the class list (name, description, how many models, connectors, projects, conversations; rename, retire, delete
with the 409 explained); an **Other services** block (web search, embeddings, reranking: which classes each may
receive). **Models** (`components/admin/model-form-dialog.tsx`) gains an "Approved for" multi-select, empty by
default with the words "No class: this model cannot receive labelled content". **Connectors**
(`connector-form-dialog.tsx`) gains "Carries" (multi-select plus an explicit "Carries no classified data"), and a
"Not reviewed" badge. User detail lists a person's projects and labels for an admin to set (names visible to
admins only).

## Conversation UI

Chips under the title: each class with its reason ("Student records: project", "from the SIS connector", "added by
you"); person-added chips have a remove button, others explain why not. "Add label" lists non-retired classes.
Project settings (`components/projects/project-dialogs.tsx`, `routes/projects/project.tsx`) get the same control.
**Picker** (`components/chat/model-picker*.tsx`): from `GET /api/classification`, blocked models stay listed but
`aria-disabled` with "Not approved for Student records" (text, not colour alone); in `warn` they are selectable
with an amber note. `startingModel` (`lib/starting-model.ts`) must not pick an unapproved default for a labelled
project. A blocked send re-fills the box (existing behaviour) and shows the message with the approved models as
buttons. Reply notices for warned or withheld tools and searches use `data-classification`.

## Audit and metrics

Audit (metadata only: ids, names *at the time*, point, destination kind, tool id, model slug; never text, titles,
arguments or results):

| Action | Who | Protected from retention |
|---|---|---|
| `data_class.create/update/retire/delete`, `model.data_classes.update`, `connector.data_classes.update`, `settings.classification.update`, `project.data_classes.update` (admin or owner) | admin / owner | admin ones: yes (`PROTECTED_AUDIT_ACTIONS`, `shared/constants.ts:~140`) |
| `thread.data_class.add/remove` | owner | no |
| `classification.block`, `classification.warn` | the person | no (normal retention; also in the compliance export) |

Metrics: counter `oci_classification_decisions_total{point,outcome}` (`point` = send, approval, tool, compaction,
web_search, embedding, rerank, share; `outcome` = allowed, warned, blocked), counted only when the conversation
has at least one class. No class label (names may be sensitive; cardinality), added in
`observability/metrics.ts` and `events.ts` next to `toolCalls`.

## Rolling upgrade

0052 is additive: new tables, nullable column, functions and triggers; no rewrite, no drop; `pnpm lint:migrations`
clean (new tables in the same file are exempt; the triggers take a brief `SHARE ROW EXCLUSIVE` on `thread`,
`project`, `connector`, covered by the migrator's 3 s lock timeout and retries). The `0.14.thread-connector-use`
background migration (batches by `message` key, `jsonb_path_exists(parts, '$[*] ? (@.type starts with "tool-mcp__")')`,
slug taken from the tool id, insert-on-conflict-do-nothing) is scheduled by `migrate --post`. A slug reused after a
connector was deleted over-labels (the safe direction).

**What a mixed version means for safety:** a v0.13 replica reads none of this: it does not enforce, does not record
connector use, and ignores the `classification` setting. Triggers still keep labels consistent for forks, moves
and deletions it performs. So **during a rolling upgrade, and after a rollback to v0.13, classification is not
enforced.** Hence the mode cannot be turned on until `migrate --post` has run (every replica is 0.14), and a
v0.13 replica's tool runs in the window are found by the backfill. Say so in `docs/OPERATIONS.md` (upgrade note for
0.14), in `docs/admin/data-classification.md`, in the CHANGELOG **Upgrade note**, and in the admin page's banner.

## Docs

New `docs/admin/data-classification.md` (concepts, modes, set-up order: define, approve models, label connectors,
turn on warn, read the audit, then block; the not-controlled list; mixed-version text). Edit `admin/{models-providers,
connectors,governance,audit-reporting,observability}.md`, `user/{conversations,projects,sharing,memory,web-search}.md`,
`OPERATIONS.md`, `dev/{database,tools-design,api-reference}.md`, `CHANGELOG.md`, `ROADMAP.md`.

## Files touched (expected)

`packages/db/drizzle/0052_data_classification.sql` (+ journal), `packages/db/src/schema/{classification,connector}.ts`,
`packages/db/src/background/thread-connector-use.ts`, `packages/shared/src/{errors.ts,schemas/}`,
`apps/api/src/services/classification/{resolve,guard,store,audit}.ts`, `routes/{classification,projects,threads,share-links}.ts`,
`routes/admin/{classification,models,connectors,index}.ts`, the chat, tools, memory, share, project-search and
vector-store files named in the table above, `services/observability/{metrics,events}.ts`, `apps/web/src` (admin
route and nav, model and connector dialogs, picker, labels component, `use-classification`), `apps/api/vitest.config.ts`,
`tools/upgrade-test`, the docs.

## Commands (module-specific)

```sh
pnpm lint:migrations
python3 $H/run.py test classification <the new live and unit files>
python3 $H/run.py web tests/unit
node tools/upgrade-test/run.mjs --from v0.13.1
```

## Testing strategy

- **Red first:** before any code, live tests that on v0.13.1 behaviour a labelled-project conversation sends to an
  unapproved model, a connector tool runs, a search query leaves and a share link is created; they fail, then pass.
- **Resolver (live PostgreSQL):** every row of the case table, each source alone and combined, retired class,
  `kept` rows after project move, project delete, connector delete and fork (each through **raw SQL as a v0.13
  replica would write it**), mode `off` doing no class query, fail-closed on a forced read error, the fallback scan
  before and after the background migration, rename and the 409 on delete.
- **Every enforcement point with a fake provider** (`MockLanguageModelV4`, `test/chat-tools.fixtures.ts`; fake
  embeddings/reranker; the in-process MCP server `test/mcp-server.ts`): a, c, e (manual and automatic), f, g, h, i,
  j, k (including no starvation of other files), l (create refused, existing link 404, owner list).
  Each asserts **the provider/search/embedding/rerank fake received zero calls** when blocked and exactly one when
  allowed or warned.
- **Tool not executed:** the MCP fixture counts `tools/call`; blocked means 0, no `tool.call outcome=ok`, no use row,
  the model's next step receives the unavailable text, and the audit pair exists. Also: classes changed mid-turn, and
  a write tool approved after a label was added.
- **Permissions:** another person's thread or project is 404; a non-admin gets 403 on every admin route; the
  person cannot remove `kept` or connector labels (409) nor an admin-`locked` project label; an auditor cannot write;
  anonymous share reads never disclose a class.
- **Audit and metrics:** every event above, content-free (assert no message text in `metadata`); counters.
- **Upgrade:** the v0.13.1 rolling-upgrade test under load; a v0.13 replica forks, moves and deletes, then v0.14
  enforces on the result; mode refused before `migrate --post`.
- **Browser (Playwright, as `model-picker.spec.ts`, `projects.spec.ts`, `connectors.spec.ts`):** admin defines a
  class and approves a model; project labelled; picker shows the disabled model with the reason; blocked send keeps
  the text; warn notice; chips add/remove; unreviewed connector badge. Add the new page to the accessibility specs.
- **Coverage floors** (`apps/api/vitest.config.ts`, as for `auth/permissions.ts`): `classification/resolve.ts` and
  `guard.ts` 100/100/100; `classification/store.ts` 92/85/100; both new route files 95/90/100; zero skips.

## Boundaries (module-specific)

- **Always:** gate on the server; fail closed in `block`; record connector use in every mode; keep audit free of
  content; keep names out of logs, spans and metric labels; keep `message_*` and v0.13 paths untouched.
- **Ask first:** a force-delete of a class; admin removal of `kept` labels; any new outbound approval concept.
- **Never:** let the client decide; add a ranking; weaken the tool-offer or approval checks; run a connector tool
  before its gate.

## Success criteria

All acceptance items hold; every row of the enforcement table has a passing test with a zero-call assertion;
#395 closed; upgrade test passes; the docs state the mixed-version window and the not-controlled list.

## Decisions (mine, for review)

1. Join tables; connector **use** stored, classes read live; frozen (`kept`) labels via triggers.
2. Warn never interrupts: composer notice, reply notice, audit. It is a dry run of `block`.
3. Web search, embeddings and reranking are approved per class in the instance setting, default none.
4. Tools are withheld from the offer in `block` *and* refused at execute.
5. 403 `DATA_CLASS_BLOCKED` with `details`, matching the model refusals already 403.

## Open questions

1. **Outbound arguments to unlabelled connectors** (and write tools like "create event"). Recommend: not in 0.14;
   document it; follow-up issue for a per-class "may receive" list on connectors, because the decided "carries"
   list has the opposite meaning.
2. **Web search/embeddings/reranking approvals** in settings (as designed) vs always withheld for labelled
   conversations. Recommend as designed.
3. **Warn: confirm before sending?** Recommend no; a stale web tab could not confirm, and the audit gives the dry run.
4. **Admins labelling user projects** needs project names shown to admins. Recommend: names to admins only, in
   user detail; `locked` labels.
5. **Removing a `kept` label.** Recommend none in 0.14 (strict); revisit with feedback.
6. **Labels in thread exports and the compliance export.** Recommend no for 0.14.
7. **Pausing existing share links** on a labelled conversation (404) vs revoking. Recommend pausing.

## What I could not verify

I ran nothing. Not read: `run-lifecycle.ts`/`thread-claim.ts` internals (so the exact `lockChatThread` use is an
inference), `pgvector-sql.ts` and `LIVE_FILE`, the composer, thread page and project page markup, auditor handling in
`requireAdmin`, the artifact sandbox, and whether an admin projects route exists (a grep found none). The backfill
SQL and the trigger ordering claim (BEFORE vs the RI AFTER triggers) are untested design. `docs/dev/v0.9-design.md`
was read only for memory and compliance.
