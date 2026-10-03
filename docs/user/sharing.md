# Sharing a conversation

Sharing publishes a read-only copy at a link anybody can open, without needing
an account.

## Creating a link

Open the conversation and choose **Share conversation** (the share icon at the
top right). Pick what the link shows and, if you like, when it stops working,
then create it and copy the link.

**Share through** decides whether the link is live or a snapshot:

- **Latest messages (live)**, the default, shows the conversation as it is
  whenever someone opens the link, including messages you add later.
- **A particular message** makes a **snapshot**: the link shows the
  conversation up to and including that message, and nothing you add
  afterwards. Use this when you want a link you sent last week to keep showing
  what it showed then.

**Expires (optional)** sets a date and time, in your local time, after which
the link stops working. Leave it blank for a link that works until you revoke
it.

The same dialog lists the conversation's links, each marked **Live** or
**Snapshot** with its view count and expiry, so you can copy or revoke them.

## What is included

- The conversation's title and its messages: your messages and the replies, one
  reply per turn as you see it.
- The sources a reply cited, and a one-line summary of each tool step it took.
- Artifacts the shared replies created, at their latest version (for a
  snapshot, the latest version at the time you created the link).

Not included:

- **Your reasoning panels.** The thinking a model did on the way to an answer is
  yours, not part of the published answer.
- **Your attachments.** Files you attached stay private; the shared page shows
  the messages without them.
- **Anything about your account**, or which model wrote each reply.

Text that looks like a password, API key or access token is replaced with
`[REDACTED]` on the shared page. Do not rely on that to catch everything.

## Revoking

Revoking a link makes it stop working immediately. Anybody who opened it
before that keeps whatever they saved or copied — revoking removes access, not
memory. An expired link stops working the same way.

Deleting a conversation, including automatic retention cleanup, also revokes
its links. Restoring the conversation does **not** reactivate those links. To
share it again, create a new link. Links to temporary conversations stop serving
content when the conversation expires, even before background cleanup runs.

## Before you share

The link needs no account, so treat it as public. A live link also publishes
whatever you add to the conversation later. If a conversation contains anything
you would not put on a public page, it should not be shared this way.

Your administrator can turn sharing off entirely, or for your role; if you
cannot find the option, that is why.
