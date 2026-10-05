# Limits

Your institution may cap how much you can use, to keep one person's activity
from consuming a shared budget.

## What you will see

Usage appears as **a percentage remaining**, under Settings and beside your
name. Never a number of messages, tokens, or an amount of money. Each limit is
named by what it counts ("Message limit", "Token limit", or "Usage limit" for
spending) and the period it covers, such as today or this month.

That is deliberate. What a token costs is not something you can act on, and
showing it invites either anxiety or gaming. A percentage answers the only
question you actually have: how much is left.

Two notices exist:

- **Approaching** — you are near the limit. Nothing has stopped.
- **Reached** — sending is blocked until the window resets.

Neither carries figures, for the same reason.

## When a limit resets

Depends on how it was configured:

- **A rolling window** — the last 24 hours, or the last 7 days, moving
  continuously. Usage falls away as it ages out, so capacity returns gradually.
- **A calendar window** — a day, week, or month that resets on a boundary.
  Everything returns at once.

Settings shows which applies and when the next reset is.

In-progress replies reserve some allowance. If a model does not report its
usage, that estimate remains held until complete usage arrives or the request
falls outside your quota window. Cancelling a reply does not necessarily make
it free.

## Different limits for different models

A limit may apply to specific models rather than everything. An instance often
allows generous use of an inexpensive model and restricts an expensive one.

If you are blocked on one model, another may still be available — the picker
does not grey these out, so trying is the quickest way to find out.

## Storage

Attachments count against a separate allowance, also shown as a percentage. It
measures what you are holding right now, not what you have ever uploaded, so
deleting files frees space.

Moving a conversation to trash also frees its files' allowance immediately.
Restoring it requires enough free space again. In-progress uploads reserve
allowance too. Manage files in [Settings → Attachments](settings.md#attachments).

## Waiting for a busy model

The companies that run the models limit how much an institution can send
them each minute. When everyone is busy at once, your message may wait its
turn before the reply starts. The reply then shows "Waiting for *model* —
you're number *N*", and an estimate when there is one.

- The wait is fair: people take turns, so somebody sending many messages at
  once does not hold you back.
- Your place is kept if you reload the page or open the conversation
  elsewhere.
- **Stop** takes your message out of the queue. It was never sent to the
  model, so it costs none of your allowance.
- If the wait runs too long (two minutes unless your institution chose
  otherwise), the reply says the model is busy; try again in a few minutes,
  or choose another model.
- Rarely the reply says the server restarted before it started. Your message
  is usually sent again by itself; if not, use **Retry**.

## Rate limits

Separately from quotas, an instance limits how quickly requests can be made and
how many replies can stream at once. You are unlikely to meet these while
working normally; they exist to stop one client overwhelming the instance.

If you do, waiting a moment is the whole remedy.

## If a limit is wrong for your work

Quotas are set per role, and an administrator can grant an individual override
without changing the policy for everyone. Features are set per role too: web
search, attachments, share links, temporary chats, branching and the reasoning
levels you can choose may each be switched off for a role while the rest of the
instance keeps them. A refused request says it is "not available for your
role".

Ask, and say what you are doing — "I am running a literature review across 300
papers" is a case somebody can act on.
