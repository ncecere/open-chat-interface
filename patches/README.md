# Dependency patches

## `postgres@3.4.9.patch`

Postgres.js 3.4.9's `sql.end({ timeout })` can finish waiting without destroying
its TCP socket. Its timeout path calls `terminate()`, which sends `socket.end()`;
a peer that keeps its writable half open leaves the client socket in `readOnly`
state. Repeated job attempts could then accumulate connections despite closing
each private client.

The first part of the patch makes only the **forced shutdown path** call
`socket.destroy()`.
Normal graceful shutdown is unchanged. Both ESM (`src/`) and CommonJS (`cjs/src/`)
implementations are patched. The patch applies to all workspace consumers of the
pinned driver, not just background jobs.

`apps/api/src/__tests__/integration/postgres-shutdown.integration.test.ts` starts
an isolated local TCP peer, accepts the PostgreSQL startup handshake, and never
answers the unlock query or closes its writable half. It verifies query rejection
and actual client socket destruction after the shutdown deadline for both module
formats. Both tests fail against the unpatched driver. No external database is
needed for this transport regression.

### Connections closed by the server (v0.11 failover safety)

A database failover (or `pg_terminate_backend`) closes every connection from
the server side. Postgres.js 3.4.9 mishandles a connection closed that way
while a transaction or reservation is using it, in four ways, all in the
close path (`closed()` and `execute()` in `src/connection.js`, `reserve()` in
`src/index.js`). The patch fixes each, in both module formats:

1. **Uncaught exception (process crash).** `begin()` rejects when its
   connection closes, but its scope then sends `ROLLBACK` through
   `execute()` on the closed connection. The write is deferred with
   `setImmediate`, and `nextWrite()` calls `socket.write` on a socket
   `closed()` already set to `null`: `TypeError: Cannot read properties of
   null (reading 'write')`, thrown outside any promise, so an
   `uncaughtException` that ends the Node process (upstream
   porsager/postgres#1154, open). The patch makes `execute()` reject a query
   with `CONNECTION_CLOSED` when the connection has no socket.
2. **The pool stops serving (closed connection moved to `full`).** The
   transaction and reservation handlers run `c.execute(q) || move(c, full)`.
   `execute()` must answer `true` ("not full") for the rejected query, or the
   closed connection is moved into the `full` queue, which nothing empties;
   after as many failures as the pool has connections, every query waits for
   ever.
3. **Stale state reused by the next session.** `closed()` cancelled the
   pending write but kept `nextWriteTimer` set, so a reconnect never sent its
   startup message (it ended in `CONNECT_TIMEOUT`); it kept the unsent bytes in
   `chunk`; it kept a FATAL `errorResponse` that was waiting for a
   `ReadyForQuery` that never came, which then failed the reconnected
   session's first query with `57P01`; and it kept the rejected `query` as the
   one in flight. All are cleared on close.
4. **A dead reserved connection returned to the pool.** `release()` of a
   reserved connection that closed meanwhile put it back in the `open` queue,
   where it rejected every query routed to it. It is now returned only if it
   is still idle in the reserved (or full) queue.

`apps/api/src/__tests__/live/postgres-transaction-failover.live.test.ts`
terminates the backend of a transaction (`sql.begin` and Drizzle's
`db.transaction`, between statements and in the middle of one) and of a
reserved connection, more times than the pool has connections, and checks
that the transaction rejects with a connection error, that nothing escapes as
an `uncaughtException` or unhandled rejection, and that the pool serves the
next queries. Against the unpatched driver the same sequence produced four
uncaught `TypeError`s and then a pool that never answered again (reproduced
with a standalone script against pristine `postgres@3.4.9`). The failover tests
(`failover-*.live.test.ts`) and the drill (`tools/failover-drill`) exercise the
same paths through the application. A guard in OCI's own code cannot stand in
for the patch: the exception is thrown from a timer inside the driver, and the
other defects are in its pool bookkeeping.

The workspace manifest and lockfile pin the patch. Docker build stages must copy
`patches/` before frozen-lockfile installation. On a driver upgrade, rerun the
transport and failover regressions without the patch; remove each part when
upstream meets the same contract. Keep the live PostgreSQL job-lock tests as separate ownership
and persistence checks.
