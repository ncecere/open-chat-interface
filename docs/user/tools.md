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

Each tool call appears in the reply as a short line, for example:

> Searched the web for 'library opening hours' · 5 results

Select the line to see what the model asked the tool for (its inputs) and a
summary of what came back. Sources a tool found — web search results, or
documents a connector linked to — appear above the answer, the same way as web
search sources always have.

A reply can take at most a set number of steps (8 unless your administrator
changed it). If a reply reaches that limit, or your usage allowance runs out
part-way through, it stops and says so under the tool steps. Ask a narrower
question, or continue in a new message.

## Approvals

Tools that only look things up run without asking. Tools that **change
something elsewhere** — sending a message, creating a record — always ask you
first. The reply pauses and shows a card with:

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

Share links and exports show each tool step as its one-line summary. The raw
results a tool returned are left out.

## Privacy

Tool inputs and results are stored in the conversation and follow its
retention, like the rest of the conversation. Your institution's audit log
records that a tool was called, whether it was approved and how it ended, but
not its inputs or results.
