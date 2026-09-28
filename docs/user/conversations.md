# Conversations

![A conversation](../images/user-conversation.png)

## What you can do to a message

Hovering over a message reveals its controls.

| Control | On | What it does |
| --- | --- | --- |
| **Copy message** | Either | Copies the text to your clipboard |
| **Edit message** | Yours | Rewrites your question and answers again |
| **Retry** | The reply | Answers the same question again |
| **Fork conversation here** | Either | Starts a separate conversation from this point |

### Editing, retrying and forking preserve the original

Editing creates a branch with your revised question. Retrying generates another
answer to the selected stored question, using context through that question;
later messages remain stored but are not included in the retry.

Forking copies the conversation up to the chosen point into a new one and leaves
the original untouched, so you can pursue an alternative without losing the
answer you already have.

This is worth reaching for more often than people do. Asking "what if we did it
the other way?" as a fork means you end up with both answers side by side in
the sidebar rather than one overwritten by the other.

## Reasoning

Some models work through a problem before answering. Where they do, that
thinking appears above the reply in a panel of its own.

It opens automatically while thinking is the only thing happening — otherwise
you would watch a blank screen during the longest wait — and collapses once the
answer starts. Clicking it always wins over that behaviour.

Models that support **effort control** let you ask for more or less of this.
Higher effort means a slower, more considered answer; lower means a quicker one.
The control sits beside the model name when the chosen model offers it.

## Temporary chats

A temporary chat stays off the sidebar, becomes unavailable when it expires,
and is removed by background cleanup. The instance still stores it while it is
active.

Temporary does not mean trace-free: usage and audit records may remain, and the
model provider's retention policy still applies. Check your institution's data
policy before sending sensitive information.

## Switching model mid-conversation

You can change model at any point. The new model receives the recent conversation
context that fits its input budget, including eligible earlier attachments.

This is a practical way to work: start somewhere fast and cheap, and move to a
more capable model at the point the question turns difficult. Each reply records
which model produced it, so the conversation stays readable afterwards.

## Reconnecting to a reply

A live reply can usually reconnect, but its replay cache has a size limit and
expires. If replay fails, the app checks saved history for a known pending reply.
You can also choose **Reload saved messages**. This does not resend a failed
request; copy any unsaved message text before replacing local history. A draft
you are typing stays in the composer during recovery.

A pending reply may still be running. You can wait or request **Stop**; a local
reader closing is not proof that the server stopped. Moving to another
conversation closes its browser reader without cancelling the server response.

Load failures show a retry or unavailable state rather than an empty chat.
Opening another conversation will not send a pending new-chat prompt there.

## What the model can see

The visible transcript is not always the entire input sent to a model. Older
turns are omitted as needed to fit a bounded recent history. A notice above the
reply tells you when earlier context was omitted; your stored messages are not
deleted or rewritten.

Your latest request, system instructions, selected attachments and any current
search grounding must fit together. If they do not, the request is refused
before a new user turn is saved. Shorten it, remove files, or choose a model with
more context. The application also has fixed safety ceilings, so choosing a
larger model does not remove every limit.

## Organising the sidebar

- **Pin** a conversation to hold it at the top, above the date groupings.
- **Archive** one to remove it from the list without deleting it. Archived
  conversations remain under [Settings → History](settings.md#history).
- **Search** matches titles and contents, not just titles.

## Where conversations go

Your institution may set a retention period, after which conversations are
removed automatically. If one applies, it is described under
[Settings → History](settings.md#history).

Deleting a conversation yourself moves it to a recoverable state first, so an
accidental deletion is not immediately final. How long that lasts is set by your
administrator.
