# Dependency patches

## `postgres@3.4.9.patch`

Postgres.js 3.4.9's `sql.end({ timeout })` can finish waiting without destroying
its TCP socket. Its timeout path calls `terminate()`, which sends `socket.end()`;
a peer that keeps its writable half open leaves the client socket in `readOnly`
state. Repeated job attempts could then accumulate connections despite closing
each private client.

This patch makes only the **forced shutdown path** call `socket.destroy()`.
Normal graceful shutdown is unchanged. Both ESM (`src/`) and CommonJS (`cjs/src/`)
implementations are patched. The patch applies to all workspace consumers of the
pinned driver, not just background jobs.

`apps/api/src/__tests__/integration/postgres-shutdown.integration.test.ts` starts
an isolated local TCP peer, accepts the PostgreSQL startup handshake, and never
answers the unlock query or closes its writable half. It verifies query rejection
and actual client socket destruction after the shutdown deadline for both module
formats. Both tests fail against the unpatched driver. No external database is
needed for this transport regression.

The workspace manifest and lockfile pin the patch. Docker build stages must copy
`patches/` before frozen-lockfile installation. On a driver upgrade, rerun the
transport regressions without the patch; remove it when upstream shutdown meets
the same contract. Keep the live PostgreSQL job-lock tests as separate ownership
and persistence checks.
