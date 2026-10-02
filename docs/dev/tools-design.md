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
| Step limit | At most **8** model steps per reply by default, adjustable on General settings (1–20). Reaching it ends the reply with a visible note. |
| Unanswered approvals | No timer. An approval waits until the person answers it. Sending a new message instead denies every unanswered approval in that conversation with the reason "not answered", so the model never sees a dangling call. |
| Temporary chats | Tools are allowed under the same rules. Audit events record metadata only (see below), so nothing from the chat's content outlives it. |
| Project-file search | Keyword search (PostgreSQL full-text) over chunks of extracted text. No embeddings provider is needed. Meaning-based search can be added later behind the same interface. |

## Tool registry

One module (`apps/api/src/services/tools/`) declares every tool OCI can offer:

- an id (`web_search`, `mcp.<connector>.<tool>`), a label and a description
  for the model;
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
same place. Share links and exports include the steps' summaries but not raw
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
   share is used.

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

## Not in v0.8

Tools inside artifacts, code execution, assistants that bundle tools, and
meaning-based (embedding) search. Each builds on this foundation later.
