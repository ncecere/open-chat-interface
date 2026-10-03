# Conversations

![A conversation](../images/user-conversation.png)

## What you can do to a message

Hovering over a message reveals its controls.

| Control | On | What it does |
| --- | --- | --- |
| **Copy message** | Either | Copies the text to your clipboard |
| **Edit message** | Yours | Rewrites your question and answers again |
| **Retry** | The latest reply | Answers the same question again, keeping the earlier reply |
| **Previous reply** / **Next reply** | The latest reply, once retried | Switches between the replies to your latest question |
| **Fork conversation here** | Either | Starts a separate conversation from this point |

### Editing, retrying and forking preserve the original

Editing creates a new conversation with your revised question; the original
stays as it was.

Retrying answers your latest question again, using the conversation up to that
question. The earlier reply is kept: below the latest reply, **‹ 2 / 3 ›**
shows which reply you are reading, and **Previous reply** and **Next reply**
switch between them (screen readers announce "Reply 2 of 3"). The reply you
leave showing is the one that counts: it is what the model sees as context for
your next question, and what exports, share links and search include. The other
replies stay stored but are left out of all of those. Every reply generated
still counts towards your usage.

You can retry and switch only on the latest reply, and not while a reply is
being generated. Once you ask another question, the reply showing becomes part
of the conversation. To take an earlier question in a different direction,
edit it or fork from it instead.

Forking copies the conversation up to the chosen point into a new one and leaves
the original untouched, so you can pursue an alternative without losing the
answer you already have.

This is worth reaching for more often than people do. Asking "what if we did it
the other way?" as a fork means you end up with both answers side by side in
the sidebar rather than one overwritten by the other.

## Reasoning

Some models work through a problem before answering. Where they do, that
thinking appears in the reply, where it happened, as a collapsed **Reasoning**
heading you can select to read it in full. A reply that uses tools can think
more than once, and each piece of reasoning sits before the step it led to.

While the model is still thinking, the heading reads **Thinking…** and a small
window under it shows the latest few lines as they arrive, so you can follow
along without the reply jumping around. Select the heading or the window to
read the whole reasoning so far. Once the model moves on (to a tool step or the
answer) the window goes and the heading becomes **Reasoning** again. If you
opened or collapsed the reasoning yourself, it stays the way you left it.
Screen readers get the heading and, when expanded, the full text; the moving
window is not read out.

Models that support **effort control** let you ask for more or less of this.
Higher effort means a slower, more considered answer; lower means a quicker one.
The control sits beside the model name when the chosen model offers it. It
starts at the level your administrator chose as the default (Instant unless
they changed it), and it lists only the levels your role may use.

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

The visible transcript is not always the entire input sent to a model. When a
conversation grows longer than the model can take in, its earlier messages are
summarised (see [Long conversations](#long-conversations)). If they cannot be,
older turns are left out to fit a bounded recent history, and a notice above
the reply says that earlier context was omitted. Either way, your stored
messages are not deleted or rewritten.

Your latest request, system instructions, selected attachments and any current
search grounding must fit together. If they do not, the request is refused
before a new user turn is saved. Shorten it, remove files, or choose a model with
more context. The application also has fixed safety ceilings, so choosing a
larger model does not remove every limit.

## Long conversations

When a conversation grows long, OCI summarises its earlier messages in the
background and from then on sends the model that summary followed by your most
recent exchanges, word for word, instead of leaving the earlier part out. A
quiet line appears above the first message the model still sees in full:
**Earlier messages are summarised for the model**. Select it to read the
summary the model receives.

- **It never stops you.** Summaries are made in the background, after a reply
  has finished. You can keep writing, sending, retrying, switching replies and
  answering approvals while one is being made; nothing waits for it and nothing
  is refused because of it.
- **Nothing is deleted.** Every message above the line stays in the
  conversation exactly as it was, and in search, exports and share links. Only
  what is sent to the model changes. A full export (Settings → Your data) also
  includes the summaries.
- **What the summary keeps:** the topic and your goal; facts, figures and
  decisions; your preferences and constraints; open questions and next steps;
  and details to keep exactly, such as names, numbers, code and quotations.
  Reasoning is not included, and long tool results are shortened.
- **When it happens:** after a reply, once the conversation takes up about
  three quarters of what the model can take in, so the summary is usually
  ready before it is needed. The most recent exchanges, up to about half of
  what the model can take in, are always kept in full, your latest exchange is
  never summarised, and a conversation is never cut in the middle of a
  question and its answer. A later summary builds on the previous one.
- **If a reply comes before the summary is ready** and the conversation no
  longer fits, that reply is sent the most recent exchanges that fit, without
  the oldest ones, and says that earlier context was left out (as before
  summaries existed). The same happens, once, if the model's provider reports
  that the input was too long: the reply is tried again with fewer earlier
  exchanges.
- **It counts towards your usage.** The summary is written by the
  conversation's own model, like a reply. When your usage allowance is spent,
  no summary is made; OCI tries again later.
- **Summarise it yourself.** **Summarise earlier messages now** (the folding
  icon at the top right of a conversation) asks for a summary straight away,
  keeping at most the latest half. You can say what the summary should keep,
  for example "keep every figure in the budget". The dialog closes at once;
  while the summary is made, the icon shows **Summarising earlier messages…**
  and you can keep writing. Asking again meanwhile does not make a second one.
  It uses the model of the latest reply.
- **Forks and edits** carry the summary over when everything it covers was
  copied into the new conversation.

Your administrator can turn automatic summaries off; then earlier messages are
left out instead, as described above, and you can still ask for a summary
yourself.

## Organising the sidebar

The sidebar lists your [projects](projects.md#projects-in-the-sidebar), each
with its own conversations, and then your other conversations under **Pinned**,
**Today**, **Yesterday** and **Older**. A conversation in a project is listed
under its project, not in the date groupings.

- **Pin** a conversation to hold it at the top, above the date groupings.
  Pinned conversations are always listed under **Pinned**, including those in
  a project, which show the project's name after their title.
- **Archive** one to remove it from the list without deleting it. Archived
  conversations remain under [Settings → History](settings.md#history).
- **Search** finds conversations by title and by what was said in them,
  including those in projects. See
  [Finding a conversation](#finding-a-conversation).

## Finding a conversation

Type in the sidebar's search box, or press `Cmd/Ctrl + K`, to search your
conversations. Results show each conversation's title with the best-matching
lines underneath, matched words highlighted, best match first.

- Every word you type must appear, and each matches the start of a word:
  `migr plan` finds "migration planning". Punctuation and symbols are ignored.
- Search covers titles, your messages and the replies you were shown. It does
  not search reasoning, web search sources, or the contents of attached files.
- Archived conversations are included and marked **Archived**. Conversations
  in the trash and temporary chats are not.
- Choosing a result opens the conversation at the matching message, briefly
  highlighted, instead of at the end. **Jump to latest** takes you to the end.

## Where conversations go

Your institution may set a retention period, after which conversations are
removed automatically. Conversations it removes go to the trash first, where
[Settings → History](settings.md#history) shows them as removed automatically
and when each will be deleted.

Deleting a conversation yourself moves it to a recoverable state first, so an
accidental deletion is not immediately final. How long that lasts is set by your
administrator.
