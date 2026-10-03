# Connectors

Your institution can connect OCI to other services — a document store, a
ticketing system, a wiki — so that models can use their tools while they
answer you. Some of these need your own sign-in, so that the service shows
you only what your own account may see.

## Connecting your account

Open **Settings → Connectors**. It lists the services you can connect: the
ones whose tools your role may use and that need your own sign-in. (Services
that need no sign-in, or that your institution signs in to for everyone,
work without anything from you and are not listed.)

1. Select **Connect** next to the service.
2. Sign in to the service and approve access for Open Chat Interface.
3. You come back to Settings → Connectors, which shows the service as
   **Connected**.

From then on, tool-capable models can use the service's tools in your
conversations, with your account. Until you connect, those tools are not
offered to the model at all.

While a model that can use tools is selected, a small note above the message
box reminds you of a service you have not connected yet: "Connect Docs to let
the model use its tools". The link opens Settings → Connectors. Select the
**×** next to it to dismiss the note for that service. OCI then suggests the
next unconnected service, if there is one. Dismissals are remembered in this
browser only. Services you dismissed stay listed in Settings → Connectors,
where you can still connect them.

If a connection expires or the service refuses it, the service shows
**Connection expired** and a **Reconnect** button, and the note above the
message box says **Reconnect** instead. A reply that tried to use it says to
connect again.

## Disconnecting

Select **Disconnect**. OCI deletes your tokens and, when the service supports
it, asks the service to revoke them. Models stop using the service's tools for
you straight away. Your existing conversations keep the tool steps they
already show.

## Approvals

Tools that only look things up run without asking. Tools that change
something in the service — creating a page, updating a ticket — always ask you
first, with the exact inputs they will run with. See
[Tools](tools.md#approvals).

## Privacy

What a tool looked up, and what it returned, is stored in the conversation and
follows its retention. Your institution's audit log records that you connected
or disconnected a service and that a tool was called, but not what it was
asked or what it returned. Your tokens are stored encrypted and are only ever
sent to that service.
