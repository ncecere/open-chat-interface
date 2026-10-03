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
Whether the control appears does not depend on which model you have chosen,
but what happens when you send does.

## What you get back

How the search runs depends on the model.

**With a model that can call tools** (marked *Tool calling* in the model
picker), the model gets a web search [tool](tools.md). It decides whether to
search, what to search for, and may search several times, refining the query
as it goes. Each search appears in the reply as a step such as "Searched the
web for 'library opening hours' · 5 results"; select it to see the query and
the results. A model may also decide a question needs no search at all.

**With any other model**, OCI runs one web search before the model starts
writing, using your message as the query, and gives the model the results.
The panel above the reply shows the query that was searched and the results
the model was given.

Either way the model is asked to link the sources it relies on, so claims that
came from a page usually link to it, and the sources are listed above the
reply. Open the steps or the panel when the answer matters: they let you judge
whether the searches were good ones and the sources ones you would have
chosen.

If your administrator has not allowed the web search tool for your role, tool
calling models fall back to the single search before the reply.

If a search fails, for example because the search provider rejected the
institution's key, you still get an answer. The reply shows **Web search
failed** with the reason, and the model is told to say that current sources
could not be checked. A model using the search tool sees the failure as the
step's result and answers accordingly.

A search that times out, cannot reach the provider or meets a server error is
tried once more before it counts as failed, so a brief network problem usually
goes unnoticed. If your administrator has set up a second, fallback provider,
the search then goes to it, and the reply's search details name the provider
that answered. A rejected key or a rate limit is reported straight away, since
trying again would not help. Either way a search gives up within about 25
seconds.

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
