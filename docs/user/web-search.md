# Searching the web

A model knows what it was trained on, which has a cut-off date and does not
include anything specific to your institution. Turning on **Search** lets it
look things up before answering.

## Turning it on

The **Search** control sits beside the model name in the composer. It applies to
the message you are about to send, not to the conversation as a whole, so you
can use it for one question and not the next.

If the control is absent, web search is not available to you: an administrator
has not turned it on, has turned it off for your role, or its search provider is
not fully set up.
It does not depend on which model you have chosen.

## What you get back

Before the model starts writing, OCI runs one web search using your message as
the query and gives the model the results. The model is asked to link the
sources it relies on, so claims that came from a page usually link to it.

The panel above the reply shows the query that was searched and the results
the model was given. It is worth opening when the answer matters: your message
may not have made a good search query, and the panel lets you judge whether the
sources are ones you would have chosen.

## When it helps and when it does not

**Worth turning on:** anything recent, anything with a date attached, anything
where you would otherwise have to check the answer yourself.

**Not worth it:** reasoning problems, writing and editing, or questions about
something you have attached. Searching adds a step, and for these it adds
nothing else.

## Following a link

Links in a grounded answer point outside your institution. Following one asks
for confirmation first and shows you where it goes, because a link inside an
answer has less provenance than one you found yourself.
