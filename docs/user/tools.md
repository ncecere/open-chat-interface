# Tools

Some models can use **tools** while they write a reply: they can look
something up, read the result, and decide what to do next. A reply that uses
tools may take several steps before you see the answer.

Whether a model uses tools depends on three things:

- **The model.** Only models marked as able to call tools use them. The model
  picker shows this as *Tool calling*. Other models answer exactly as before.
- **Your role.** An administrator decides which tools each role may use.
- **The tool's own switch.** Web search, for example, is only offered when
  **Search** is on for the message you send.

Tools can also come from **connectors**: other services your institution has
connected, such as a document store or a ticketing system. Some need you to
connect your own account first under **Settings → Connectors**; until you do,
their tools are not offered. See [Connectors](connectors.md).

## What a tool step looks like

A reply's tool calls, with any reasoning around them, are gathered into one
collapsed block at the top of the reply, summarised in a few words, such as
**Searched the web twice** or **Thought · used Service Desk lookup** (see
[Conversations](conversations.md#how-a-reply-shows-the-models-work)). While
the model works, the block's heading says what it is doing now, for example
**Searching the web…**. Expand the block to see each call as a short line,
for example:

> Searched the web for 'library opening hours' · 5 results

Select the line to see what the model asked the tool for (its inputs) and a
summary of what came back. A web search lists the pages it found, each with
its title and address; documents a connector linked to are a **Sources** step in
the same block. Each opens through the check for links that leave OCI.

A reply can use tools for a set number of steps (8 unless your administrator
changed it). If it reaches that limit, the model answers with what it has found
so far and a note says so. If your usage allowance runs out part-way through,
the reply stops and says so below the block. Ask a narrower
question, or continue in a new message.

## Approvals

Tools that only look things up run without asking. Tools that **change
something elsewhere** — sending a message, creating a record — always ask you
first. The reply pauses and shows a card below the work block, never hidden
inside it, with:

- the tool, and the connector it belongs to, if any;
- the exact inputs it will run with.

Choose **Approve** to let it run, or **Deny** to refuse. Either way the model
continues the same reply: after a denial it is told you said no and answers
without the tool.

An approval waits for as long as you like, including across a reload or on
another device. If you send a new message instead of answering, every
unanswered approval in the conversation is refused with the reason "not
answered", and the tool does not run.

## Shared and exported conversations

Share links show the same collapsed block, summarising the tool steps; expanded,
it lists each step's one-line summary. Exports list each tool step as its
one-line summary. The raw results a tool returned are left out of both.

## Privacy

Tool inputs and results are stored in the conversation and follow its
retention, like the rest of the conversation. Your institution's audit log
records that a tool was called, whether it was approved and how it ended, but
not its inputs or results.
