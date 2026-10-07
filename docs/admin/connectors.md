# Connectors

**Tools & integrations → Connectors** (`/admin/connectors`). A connector is a
remote [MCP](https://modelcontextprotocol.io) server that OCI talks to over
Streamable HTTP. Once you enable some of its tools and allow them for a role,
tool-capable models can call them during a reply: search a document store,
look up a ticket, create a page. See [Tools](../user/tools.md) for what
people see.

Nothing is offered until three things are true for a tool:

1. the connector is **enabled** and the tool is **enabled** on this page;
2. the tool is **allowed for the person's role** under **Roles & access →
   Tools** (connector tools are off for every role until you allow them; they
   are listed there under their connector's name);
3. for an OAuth connector, the person has **connected their own account**
   under Settings → Connectors.

The model must also have the `tool_calling` capability, as for any tool.

## Adding a connector

Choose **Add connector** and enter:

- **Name** — shown to people next to the connector's tools.
- **Server URL** — the MCP endpoint, for example
  `https://mcp.example.com/mcp`. It must be `https://` (see
  [Private networks](#private-networks)). OCI does not follow redirects, so
  enter the final address.
- **Short name** (optional) — used in tool ids, `mcp__<short name>__<tool>`.
  Chosen from the name when left empty, and fixed once saved, because role
  allows and the audit log refer to tool ids.
- **Authentication** — see below.

Then select **Refresh tools**. OCI asks the server for its tools
(`tools/list`) and lists them on the connector. **Test connection** checks the
MCP handshake and reports how many tools the server lists. A server that
answers but not as MCP (a web page, or JSON that is not JSON-RPC) is reported
as such, with its HTTP status when known: check that the URL is the server's
MCP endpoint. The connector's status line gives its last successful contact,
or says it has never connected successfully, and its last failure.

## Authentication

| Mode | How it works | Use when |
| --- | --- | --- |
| **No sign-in** | OCI sends no credential. | The server is public or protected another way. |
| **Shared credential** | OCI sends one header (for example `Authorization: Bearer …` or `X-Api-Key: …`) on every request, for everyone. | The server has a service account, and every person may see the same things. |
| **Each person signs in (OAuth)** | Each person connects their own account under Settings → Connectors. OCI calls the server with that person's token. | The server should apply each person's own permissions. |

The shared credential, the OAuth client secret and people's tokens are
encrypted at rest with the instance's `ENCRYPTION_KEY`. The page shows only
whether a secret is **set**; it never shows the value again. To change one,
choose **Replace it**; to remove it, **Remove it**.

### OAuth

OCI uses the authorization code flow with PKCE. It discovers the server's
authorization server from the server's OAuth metadata (RFC 9728 protected
resource metadata, falling back to the server itself) and:

- **registers itself** (dynamic client registration) when the authorization
  server allows it — leave **Client ID** empty; or
- uses the **Client ID** (and optional **Client secret**) you enter. Register
  the **Redirect URL** shown in the form with the server:
  `<your OCI address>/api/connectors/oauth/callback`.

**Scopes** are optional and space-separated.

The first time anyone connects, OCI records the authorization server and its
token endpoint on the connector. If the server later names a different one,
connecting is refused until you save the connector again (change its address
or client) — a changed sign-in server is something to check, not follow.

Administrators can connect their own account with **Connect your account** on
this page, even before any tool is allowed. **Refresh tools** and **Test
connection** on an OAuth connector use your own connection: tools are listed
with your sign-in.

Changing a connector's **URL**, **authentication mode** or **client ID**
disconnects everyone connected to it (their tokens were issued for the old
setup) and forgets the recorded authorization server. Changing the client
secret, name or scopes keeps connections.

## Tools: enabling and approval

Refreshed tools arrive **disabled**. Each has a kind:

- **Read** — looks something up. Runs without asking.
- **Write** — changes something elsewhere. The person approves every call.

The kind starts from the server's `readOnlyHint` annotation: **read** only
when the server declares the tool read-only, otherwise **write**. You can make
a read tool a write tool at any time, so that it asks first. Making a tool
**read** that the server does *not* declare read-only lets it run without
asking, so the page asks you to confirm, and the audit log records that you
did (`readOnlyConfirmed`). If a later refresh shows the server no longer
declares a tool read-only, it goes back to write unless you confirmed read.

**Refresh tools** updates each tool's description and input schema from the
server, adds new tools (disabled) and marks tools the server no longer lists
as *no longer listed*; those are never offered until they come back. Models
always see the description and schema stored at your last refresh: a server
cannot change what models read without an administrator refreshing.

A tool's id is `mcp__<short name>__<tool name>`, with characters other than
letters, digits, `_` and `-` replaced, because providers accept only those in
function names.

## Results and sources

A tool's result reaches the model as a tool result — never as an instruction
or part of the system prompt — and is treated as untrusted content. Text is
kept (up to 12,000 characters); images and binary content are left out and
named. Links the server returns (`resource_link`, or embedded resources with
a web address) are shown as **sources** under the reply, so answers cite the
document they came from. The server's own `instructions` from the MCP
handshake are ignored.

## Safety

- **Addresses.** OCI resolves the server's name on every connection and
  refuses private, loopback, link-local, carrier-grade NAT, multicast and
  other reserved addresses (IPv4 and IPv6, including `127.0.0.0/8`,
  `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`,
  `169.254.0.0/16`, `0.0.0.0`, `::1`, `fc00::/7`, `fe80::/10`). The check is
  made on the address the connection actually uses, so a name that resolves
  differently a moment later (DNS rebinding) cannot reach a private address.
- **Cloud metadata** addresses (`169.254.169.254`, `169.254.170.2`,
  `100.100.100.200`, `fd00:ec2::254`) are refused always, even with
  *Allow private network*.
- **Redirects** are never followed, to any host.
- **Limits.** Each MCP request has 30 seconds; a response larger than 2 MB is
  refused. A tool call that runs out of time or returns too much fails with a
  clear message, which the model sees.
- **The OAuth endpoints** (metadata, registration, token, revocation) go
  through the same checks.
- **Credentials** are sent only to the connector's server (and tokens only to
  its recorded authorization server), and are never logged, returned by the
  API or written to the audit log. A shared credential's header name cannot be
  one OCI sets itself (such as `Host` or `Content-Type`), and its value cannot
  contain line breaks.

### Private networks

**Allow private network** permits plain `http://` and private, loopback and
link-local addresses for this connector. Turn it on only for servers you run
on your own network. It is checked at every connection, so turning it off
takes effect immediately.

## Status

Each connector shows its last successful contact and its last failure.
**System health** has a **Connectors** row that warns when an enabled
connector's latest exchange failed.

## Deleting a connector

Deleting removes the connector, its tools, every person's connection, and
every role's allow for its tools. Replies that already used its tools keep
their tool steps.

## Audit

| Action | When | Metadata |
| --- | --- | --- |
| `connector.create` | A connector is added | name, short name, authentication mode, private network flag, whether a credential was set |
| `connector.update` | A connector is changed | the fields changed, each as it was and became (address, name, authentication mode and so on), whether each secret was `replaced`, `cleared` or `unchanged`, connections removed |
| `connector.delete` | A connector is deleted | name, short name, number of tools and connections removed |
| `connector.tools.refresh` | Tools are refreshed | counts added, updated and no longer listed |
| `connector.tool.update` | A tool is enabled, disabled or its kind changed | tool id, before and after, `readOnlyConfirmed` |
| `connector.account.connect` | A person connects their account | the connector |
| `connector.account.disconnect` | A person disconnects | the connector, whether the token was revoked |
| `tool.call` | A model calls a tool | as for every tool; never inputs or results |

`connector.create`, `connector.update` and `connector.delete` are kept
regardless of audit retention. Auditors can open this page and see
everything on it except secrets, and change nothing.

## Limits of the current design

- A connection is opened per tool call and closed afterwards; there is no
  pooling.
- Refreshing a person's expiring token is coordinated across every OCI
  replica (since v0.9): one replica refreshes while the others wait for it and
  then use the new token, so servers that rotate refresh tokens do not
  disconnect people who use a connector from two places at once. A refresh
  holds one database connection until the server answers. If a replica waits
  longer than the connector time limit (30 seconds), that tool call fails
  with "try again later" and the connection is kept.
- Only Streamable HTTP servers are supported, not the older HTTP+SSE
  transport or local (stdio) servers.
