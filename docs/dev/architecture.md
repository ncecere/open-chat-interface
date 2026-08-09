# Architecture

## Same origin

Caddy serves the built web application and proxies `/api` to the API on the same
origin. No CORS, and cookies are plain first-party cookies.

```
browser ──▶ Caddy ──┬──▶ static files        (apps/web build)
                    └──▶ /api  ──▶ Hono      (apps/api)
                                    ├──▶ PostgreSQL
                                    ├──▶ Redis
                                    └──▶ model providers
```

Redis is optional. Without it, resumable streams and rate limiting fall back to
per-process state, which is correct for one replica and wrong for several. The
[health page](../admin/operations.md#health) says so rather than failing.

## A chat request, end to end

Worth following once, because most of the system is on this path.

1. **`POST /api/chat`** arrives with a thread identifier, the message, and a
   model slug.
2. **Authentication** resolves the session; the middleware attaches the user.
3. **Validation** parses the body against a Zod schema from
   `packages/shared`. The schema is strict — an unknown field is an error, not
   something to ignore.
4. **Model resolution** looks the slug up and checks that this person's role may
   use it. A client asking for a model it cannot see is refused here.
5. **Rate limiting** checks requests per minute and concurrent streams.
6. **Quota reservation** writes a row holding an estimated cost *before*
   generating anything, so concurrent requests see each other. This is why a
   quota cannot be overspent by parallel requests.
7. **Generation** calls the provider through the AI SDK and streams back.
8. **Persistence** stores the message as it completes.
9. **Settlement** replaces the reservation with actual usage.

Steps 6 and 9 are the part people miss. Reserving first and settling afterwards
is what makes the quota correct under concurrency; charging afterwards alone
would let simultaneous requests each see an unspent budget.

## Package boundaries

**`packages/shared`** — types and Zod schemas. No database, no HTTP. If
something needs either, it does not belong here.

**`packages/db`** — Drizzle schema, migrations, seeds. Exports the schema and
the query builders the API uses, and re-exports the Drizzle operators so
`apps/api` does not depend on Drizzle directly.

**`apps/api`** — routes are thin. Anything with a decision in it lives in
`services/`, so it can be tested without an HTTP request.

**`apps/web`** — routes render, hooks fetch, `lib/api-client.ts` is the only
thing that talks to the network.

## Background work

`services/jobs/` holds recurring tasks: retention, storage reclamation,
scheduled reports, expiring temporary threads.

Each holds a **PostgreSQL advisory lock**, so several replicas produce one run.
The alternative — a leader election — is more machinery than a handful of
periodic jobs justifies.

## Authentication

Better Auth, with the admin and SSO plugins.

- **Roles** are `admin`, `auditor`, `user`, `restricted`.
- **The admin API** is guarded by one middleware. An auditor is allowed read
  methods and refused everything else, decided on the HTTP method rather than a
  list of endpoints — a list drifts, and drifts open.
- **SSO provisioning** runs on every login, not only the first, so group changes
  at the identity provider take effect.

## Streaming

Replies stream over Server-Sent Events. Where Redis is configured the stream is
also written there, so a client that reconnects can resume rather than losing a
half-finished reply.

Without Redis this still works within one process; it is only across replicas
that a reconnection could land somewhere that never saw the stream.
