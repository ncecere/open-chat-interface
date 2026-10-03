# Design: tools and connected knowledge (v0.8)

The design behind the four v0.8 roadmap items: the tool-calling foundation,
web search as a tool, search over large project files, and MCP connectors.
It records the decisions made before building, so reviewers can check the
code against them and later work can change them deliberately.

## Goals

- Let a model call tools during a reply: look things up, and — with the
  person's approval — act in other systems.
- Keep every existing guarantee: durable replies that survive disconnects,
  per-role entitlements, budgets, retention and the audit log.
- Degrade clearly. A model or role without tools keeps working exactly as in
  v0.7.

## Decisions

| Question | Decision |
| --- | --- |
| Which models get tools | Models whose catalog entry has the `tool_calling` capability. Administrators already edit capability tags; this makes the tag change behaviour (roadmap principle 2). |
| Step limit | At most **8** tool-using steps per reply by default, adjustable on General settings (1–20). Reaching it adds one final step with the tools withdrawn, so the reply still ends with an answer, and a visible note. |
| Unanswered approvals | No timer. An approval waits until the person answers it. Sending a new message instead denies every unanswered approval in that conversation with the reason "not answered", so the model never sees a dangling call. |
| Temporary chats | Tools are allowed under the same rules. Audit events record metadata only (see below), so nothing from the chat's content outlives it. |
| Project-file search | Keyword search (PostgreSQL full-text) over chunks of extracted text. No embeddings provider is needed. Meaning-based search can be added later behind the same interface. |

## Tool registry

One module (`apps/api/src/services/tools/`) declares every tool OCI can offer:

- an id (`web_search`, `mcp__<connector>__<tool>` — see the connector
  implementation notes for why not `mcp.<connector>.<tool>`), a label and a
  description for the model;
- an input schema (Zod for built-in tools, JSON Schema for MCP tools);
- a **kind**: `read` (looks something up) or `write` (changes something
  elsewhere). Write tools always need approval; read tools never do.
- an `execute` function that receives the input, an abort signal and the
  calling person, and returns a bounded result.

For each turn the registry builds the tool set offered to the model: tools
that are enabled on the instance, allowed for the person's role, usable by
the model (`tool_calling`), and switched on for this message where the
composer has a switch (web search). The server refuses, rather than runs, a
call to any tool outside that set.

## Per-role allow

Roles & access gains a **Tools** section listing every registered tool with a
switch per role. It is stored sparsely, like the v0.7 role features, so new
tools inherit a default: built-in read tools on for every role except
`restricted`; connector tools off until an administrator allows them. Changes
are audited as `role.tools.update`.

## The reply loop

`streamText` runs with the turn's tool set and `stopWhen` at the step limit.
Everything streams into the same assistant message, so the existing durable
claim, replay after a dropped connection, stop button and persistence apply
unchanged to multi-step replies.

Tool calls and results are stored as the SDK's tool parts on the assistant
message. Results kept for context are capped in size; the model sees the
same capped text on later turns.

**Usage.** A reply now spans several model calls. Settlement uses the total
across all steps (`totalUsage`), not the last step's figure, and the
reservation is made as today. Each extra step checks the person's remaining
allowance first and ends the reply if it is exhausted.

## Approval

When the model calls a `write` tool, the step ends with an approval request
and the reply is saved as **awaiting approval**. The conversation shows the
tool, the connector and the exact inputs, with **Approve** and **Deny**.

Answering posts to `POST /api/chat/:threadId/approvals`. The server checks
that the reply belongs to the person, is the latest reply, and is waiting on
that approval, then re-claims the same assistant message (the durable claim)
and continues the loop from where it stopped. A denial is sent to the model
as a denied result so it can respond accordingly. The composer stays usable;
sending a message instead denies open approvals as described above.

## Audit

Every tool call writes a `tool.call` event: tool id, kind, whether it needed
approval and the answer, outcome (`ok`, `error`, `denied`, `refused`),
duration and result size. Inputs and outputs are **not** written to the audit
log; they live in the conversation and follow its retention. Approvals and
denials by the person are part of that event, not separate ones.

## Showing tool use

Each tool call appears in the reply as a collapsed step, for example
"Searched the web for 'library opening hours' · 5 results", expandable to the
inputs and a summary of the result. Approval requests appear inline in the
same place. Since v0.9 steps sit where they happened in the reply (after the
reasoning that led to them, before the text that follows), and artifact tool
calls appear as the artifact's card instead of a step. Share links and exports include the steps' summaries but not raw
results.

## Web search as a tool

With a tool-capable model and the composer's **Search** switch on, the model
gets a `web_search` tool instead of OCI running one search before the reply.
It decides when and what to search, may search several times within the step
limit, and cites results as sources. With a model that lacks tool calling,
v0.7's single search before the reply still applies. Providers, the instance
switch and the per-role switch are unchanged.

## Large project files

Project files' extracted text is split into overlapping chunks when the file
is added, and indexed with PostgreSQL full-text search. On each message:

1. If every project file fits within the share of the context budget set
   aside for project files, they are included whole, as in v0.7.
2. Otherwise OCI searches the chunks with the person's message and includes
   the best-ranked passages, each labelled with its file name, until that
   share is used. (v0.9 includes only passages above a relevance floor, and
   none for an unrelated message: see
   [v0.9-design.md](v0.9-design.md#relevance-floors).)

The reply shows that project files were searched and which files the
passages came from. This works with every model. Existing project files are
chunked by a background job after the upgrade.

## MCP connectors

Administrators register remote MCP servers (Streamable HTTP) on a new
**Connectors** page:

- **Authentication:** none, a shared credential held encrypted by OCI, or
  OAuth per person. With OAuth each person connects their own account under
  Settings, so the connected system applies their own permissions.
- **Tools:** OCI lists the server's tools. Administrators enable individual
  tools; each is `read` or `write`, defaulting from the server's
  `readOnlyHint` annotation and to `write` when absent, and allowed per role
  through the same Tools section.
- **Safety:** connector URLs must be HTTPS (plain HTTP only for addresses an
  administrator explicitly allows); private and link-local addresses are
  refused unless allowed; responses are size- and time-limited; tool results
  are treated as untrusted content.
- Tool results that carry links or document references are shown as sources,
  so answers cite the document they came from.

## Implementation notes (tool foundation and web search)

Where the build differs from, or decides something left open above:

- **Awaiting approval is derived from the parts, not a status.** A reply that
  waits stays `complete`; it is awaiting approval while a tool part is in the
  SDK's `approval-requested` state. Status describes the generation run, and
  every reader of it (retention, replay, the reply switcher, search, exports)
  keeps working unchanged. No migration was needed.
- **Continuing after an approval** re-claims the same message (`streaming`)
  under the thread lock and runs as `<message id>:<suffix>`: its own stream
  slot, resumable stream and usage reservation, with a message count of 0 so
  the reply is not counted twice. A failure before the model starts puts the
  reply back to waiting. Every open approval of the reply must be answered in
  one request. An approved call to a tool that is no longer offered is refused
  (sent to the model as a denial) rather than run.
- **Usage.** In the pinned AI SDK (7.0.55) `result.usage` already totals all
  steps of a finished reply. The under-count was a reply stopped or failing
  mid-loop, whose SDK total is empty: finished steps' tokens were lost. The
  loop now tallies each step and settles a stopped reply's finished steps as a
  lower bound, leaving the usage marked unknown with the estimate held.
- **Allowance between steps** is checked when a step with tool results ends,
  before the next model call (an SDK stop condition), so a spent allowance
  ends the reply with a note. The loop also ends, with its own note, when the
  accumulated tool results would exceed the model's input budget.
- **Step limit across an approval** counts the reply's earlier steps, but a
  continuation always gets at least one model step to use the answer.
- **Earlier turns' tool steps** reach the model as tool calls and results
  when the current turn offers tools, and as a short text note otherwise,
  because providers refuse tool history in a request without tools.
  Unfinished steps are left out.
- **Web search tool** is offered when the role's `web_search` tool switch,
  the role's Web search feature, the instance's web search and the message's
  Search switch all allow it. Otherwise the v0.7 search before the reply runs.
  Built-in tools have no separate instance switch: web search's existing one
  applies.
- **Test-only tools** are added by replacing the catalogue module with
  `vi.mock`; production code has no registration API.

## Implementation notes (MCP connectors)

Where the connector build differs from, or decides something left open above
(administrator view: [docs/admin/connectors.md](../admin/connectors.md)):

- **Tool ids are `mcp__<slug>__<tool>`, not `mcp.<connector>.<tool>`.** The id
  is also the function name sent to the provider, and OpenAI and Anthropic
  accept only `^[A-Za-z0-9_-]{1,64}$`: a dotted id would be refused by the
  provider on the first turn that offered it. A connector's slug is at most 24
  characters with no underscores (so the first `__` ends it) and is fixed at
  creation. A tool's key is its MCP name with other characters replaced by
  `_`, shortened with a hash when it would exceed 64 characters or collide;
  keys are stored, so a tool keeps its id across refreshes. `TOOL_ID_PATTERN`
  and `connectorSlugOfToolId` in `@oci/shared` follow this shape.
- **The catalogue is asynchronous and database-backed.** `registeredTools()`
  returns the built-in tools plus every enabled tool of every enabled
  connector, cached for 10 seconds and cleared in-process by every
  administrator change (other replicas converge within the TTL). Execution
  re-reads the connector and tool, so a tool switched off is never run.
  `resolveTurnTools`, the role-tools service and Roles & access await it.
- **Turn input gains the person.** `ToolTurnInput` carries `userId` (an OAuth
  connector's tools are offered only to people who connected) and a per-turn
  `memo`, so the connected-accounts lookup runs once per turn.
- **Sources from any tool.** `ToolDefinition.sources(output)` replaces the
  reply loop's web-search special case; connector results list `resource_link`
  and embedded resources with web addresses as sources.
- **Kinds.** The default comes from `readOnlyHint` (`write` when absent). An
  administrator may mark any tool `write`. Marking `read` a tool the server
  does not declare read-only requires `confirmReadOnly: true` (the UI asks
  first) and is recorded (`readOnlyConfirmed`, and `read_confirmed` on the
  tool). A refresh after which the server no longer declares a tool read-only
  returns it to `write` unless that confirmation exists.
- **Untrusted results.** Results reach the model only as tool results. The
  server's `initialize` instructions are ignored, and models see the
  description and schema stored at the administrator's last refresh, never
  live `tools/list` output. A result with `isError` fails the step (audited
  as `error`) with the server's message clipped to 300 characters. Text is
  kept up to 12,000 characters; images and binary content are named, not
  included.
- **Connections are per call.** Each tool call opens an MCP client (Streamable
  HTTP, JSON-RPC `initialize`, `tools/call`) and closes it; no pooling.
- **Network safety.** All connector and OAuth traffic uses a guarded fetch
  built on `node:http(s)` with a custom socket `lookup`: the resolved
  addresses are checked inside the connection, so the address checked is the
  address connected to and DNS rebinding has no window. Each request uses a
  fresh socket (no keep-alive pool shared between connectors). Redirects are
  refused outright rather than only cross-host ones. Cloud metadata addresses
  are refused even with *Allow private network*. Responses are limited to
  2 MB and 30 seconds of idle time; IP literals are checked before connecting
  because sockets skip lookup for them.
- **OAuth uses `@ai-sdk/mcp`'s `auth()`** with database-backed providers:
  protected-resource and authorization-server discovery, dynamic client
  registration (stored on the connector as a `dynamic` client), PKCE, the
  `resource` indicator and refresh. The pending attempt (hashed state, code
  verifier, client) lives in `connector_account.pending_*` rather than a
  fourth table: one attempt per person and connector, ten minutes, bound to
  the signed-in person, consumed before the code exchange. The authorization
  server and token endpoint are pinned on the connector the first time anyone
  connects and a different one is refused until an administrator changes the
  connector's URL, authentication mode or client ID — which also deletes every
  person's connection, since their tokens were issued for the old setup.
  A refresh the server refuses (or a token the server rejects and cannot
  refresh) disconnects the account and asks the person to reconnect; a refresh
  that fails only at the network level keeps it. Disconnecting revokes the
  token (RFC 7009) when the authorization server advertises an endpoint.
- **Administrators' own connection.** Test connection and Refresh tools on an
  OAuth connector use the acting administrator's connection; administrators
  may connect before any tool is allowed for their role.
- **The "connect X" hint** lives in Settings → Connectors (which lists every
  OAuth connector with a tool allowed for the person's role) and in the
  failed step's message when a connection expires mid-use. Since v0.9 the
  composer also shows one dismissible note (`role="note"`) for the first
  unconnected or expired connector while a `tool_calling` model is selected.
  It reuses `GET /api/connectors` through the same react-query key as the
  settings page, and fetches nothing for other models. Dismissals are kept
  per connector id in `localStorage` (`oci:dismissed-connector-hints`).
- **Refresh across replicas (v0.9).** Callers in one process share one
  refresh per account; across processes, the refresh runs in a transaction
  holding the `connector_account` row with `SELECT … FOR UPDATE`. After
  acquiring the lock the row is re-read: if the tokens changed while waiting,
  another replica refreshed and those are used, so only one refresh reaches
  the server even when it rotates refresh tokens. Token writes go through the
  same transaction. The lock holds one pooled connection for the refresh;
  waiting is bounded by `lock_timeout` (the connector time limit), after which
  the caller is told to try again. A refusal disconnects only if the refused
  tokens are still the stored ones (compare-and-set on the ciphertext); a
  caller holding replaced tokens, such as the MCP transport refreshing after a
  401 mid-call (which does not take the lock), adopts the stored replacement
  instead. Covered by the live test with two module instances refreshing at
  once against the rotating test server.
- **Residual risks.** A caller that refreshed with stale tokens after a 401
  and was refused retries once with the stored replacement, rotating it again;
  if that also races, the call fails with a try-again message, but the person
  stays connected. Tool descriptions are
  server-written text that models read (prompt injection through a tool
  description is mitigated, not prevented, by administrator review at
  refresh).
- **Test server.** Live tests use a small hand-written MCP server and OAuth
  authorization server (`apps/api/test/mcp-server.ts`) on 127.0.0.1, so no
  `@modelcontextprotocol/sdk` dependency was added.

## Not in v0.8

Tools inside artifacts, code execution, assistants that bundle tools, and
meaning-based (embedding) search. Each builds on this foundation later.
