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

### Editing and retrying replace what follows

Both discard everything after the point you act on, because the rest was a
response to something that no longer stands.

If you want to keep the original, **fork first**. Forking is the non-destructive
option: it copies the conversation up to that point into a new one and leaves
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

A temporary chat is not saved. It does not appear in your sidebar, it is not
included in an export, and it is removed once it expires.

Use one when you would rather the conversation left no trace — trying an
awkwardly worded question, or working with something you do not want kept.

Everything else behaves normally. The reply is not different; only its
persistence is.

## Switching model mid-conversation

You can change model at any point. The new model sees everything already said
and continues from there.

This is a practical way to work: start somewhere fast and cheap, and move to a
more capable model at the point the question turns difficult. Each reply records
which model produced it, so the conversation stays readable afterwards.

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
