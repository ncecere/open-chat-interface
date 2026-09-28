# Local browser performance fixture

Real API routes, Better Auth password login, and migrated PostgreSQL; deterministic local inference only. This is fixture setup, not a benchmark runner. It does not start a browser or web build.

## Launch

From the repository root, with dependencies installed and a **disposable local PostgreSQL server** running (the role needs `CREATEDB`):

```sh
OCI_BROWSER_FIXTURE=1 \
TEST_DATABASE_URL=postgres://oci_test:oci_test@127.0.0.1:55441/oci_test \
pnpm --filter @oci/api exec tsx test/browser-performance/server.ts
```

The opt-in and explicit `TEST_DATABASE_URL` are mandatory. Only `127.0.0.1`, `localhost`, and `[::1]` hosts are accepted; URL query options are rejected to prevent host overrides. Inherited `DATABASE_URL` is never used. Do not load a production `.env` file.

The existing `createLiveDatabase('browser_perf')` helper creates and migrates a random `oci_test_browser_perf_*` database. The supplied database is only the control connection for creating/dropping that database; none of its tables are seeded or changed.

- API: `http://127.0.0.1:4180`
- Provider base URL: `http://127.0.0.1:4181/v1`
- Counts only: `http://127.0.0.1:4181/stats`
- Baseline UI origin: `http://127.0.0.1:4179`
- Candidate UI origin: `http://127.0.0.1:4178`

Serve the two web builds separately, with `/api` proxied to port 4180. Both origins are trusted by real authentication. Sign in through the UI; no sessions are pre-created or auth checks bypassed. Dismiss the introduction in the UI if it appears. Cookies share the loopback hostname across ports. Use an isolated named session; the warm runner intentionally shares the same fixture identity across origins. The cold runner uses a fresh browser session for every trial and obtains its cookie through the real password endpoint, not by bypassing authentication.

## Readiness and outputs

The only readiness line is:

```text
Browser performance fixture ready: /.../oci-browser-performance-XXXXXX/metadata.json
```

Each run owns a unique temporary directory, mode `0700`:

- `metadata.json` (`0644`): **non-secret** URLs, generated database name, model slug, streaming configuration, and scenario descriptors. Format: `{ version: 1, urls: { baseline, candidate, api, provider, providerStats }, model, databaseName, redis: false, stream: { chunks, initialDelayMs, chunkDelayMs, responseBytes, syntheticUsage }, scenarios: [{ label, kind, threadId, messageCount, path }] }`.
- `credentials.json` (`0600`): **secret**, `{ email, password }`, with a newly generated password. Read this sibling file locally for browser login; never print it, include it in screenshots, or publish it as a benchmark artifact.
- `storage/`: isolated local attachment storage. Generated auth/encryption secrets stay in process memory, not metadata.

Passwords, auth secrets, encryption keys, and database connection strings are not printed. Startup failures report a stage rather than serializing potentially secret-bearing errors.

## Dataset and provider behavior

- One fixture administrator: `browser-fixture@example.test`.
- Twelve `history-01` through `history-12` scenarios, each with 100 complete messages (50 user/assistant pairs), markdown tables and code, fixed positions/timestamps, and assistant-to-prompt lineage. IDs are random per run.
- Four empty scenarios: `cold-load-baseline`, `cold-load-candidate`, `small-chat-baseline`, and `small-chat-candidate`.
- One default `browser-fixture` model, visible to admins/users, 128k context and 16k maximum output; no tools, attachments, or reasoning capabilities advertised.
- `POST /v1/chat/completions`: fixed approximately 20 KB markdown, role plus 100 text chunks, first text after 150 ms, then 40 ms between chunks (~4.11 seconds total). Finish reason, usage, and `[DONE]` follow. Disconnecting clears timers.
- `stream: false` (or omitted) returns the same text as ordinary OpenAI-compatible JSON. Unknown models and invalid stream flags are rejected. Request bodies are limited to 2 MiB.
- Prompt, sampling, token limits, and other generation parameters do not change the response. Usage (512 input / 5000 output tokens) is **synthetic**, not real token accounting. The provider does no outbound fetches and does not log/store prompts or authorization headers. `/stats` exposes counts only.

Inherited `REDIS_URL` is explicitly removed: this is a deterministic **no-Redis** run, not a measurement of stream replay, distributed concurrency, or production infrastructure. No lifecycle jobs start. Timing remains subject to event-loop/host load. Seeded history has no usage ledger, attachments, search, or model reasoning. The fixture is not an outbound-network sandbox; do not reconfigure providers to external services during a run.

Use equivalent unused threads (or restart the fixture) for comparisons: real chat submissions mutate the disposable database. Thread content/order and provider output are fixed, but IDs, credentials, and subsequent user activity differ between runs.

## Browser runner setup

See [the measured results and limitations](../../../../docs/dev/browser-performance.md).
Build the candidate normally. For a disposable original-source comparison with
identical installed dependencies (not a historical dependency reproduction):

```sh
BASELINE=$(mktemp -d /tmp/oci-browser-baseline.XXXXXX)
git worktree add --detach "$BASELINE" fd4cfa0
ln -s "$PWD/node_modules" "$BASELINE/node_modules"
ln -s "$PWD/apps/web/node_modules" "$BASELINE/apps/web/node_modules"
pnpm --filter @oci/web build
pnpm --filter @oci/web exec vite build "$BASELINE/apps/web" --manifest
```

Run each preview in its own terminal or managed process:

```sh
VITE_API_PROXY=http://127.0.0.1:4180 pnpm --filter @oci/web exec vite preview --host 127.0.0.1 --port 4178 --strictPort
VITE_API_PROXY=http://127.0.0.1:4180 pnpm --filter @oci/web exec vite preview "$BASELINE/apps/web" --host 127.0.0.1 --port 4179 --strictPort
```

Set `METADATA` to the readiness path, then use a unique fixture-only auth profile.
The password below travels through stdin, not terminal output or process arguments:

```sh
METADATA=/path/from/readiness/metadata.json
SESSION=$(agent-browser session id --scope worktree --prefix oci-perf)
PROFILE="oci-perf-$(basename "$(dirname "$METADATA")")"
python3 -c 'import json,pathlib,sys; print(json.loads((pathlib.Path(sys.argv[1]).parent/"credentials.json").read_text())["password"])' "$METADATA" |
  agent-browser auth save "$PROFILE" --url http://127.0.0.1:4178/auth/login --username browser-fixture@example.test --password-stdin
agent-browser --session "$SESSION" --allowed-domains 127.0.0.1 --init-script "$PWD/apps/web/scripts/browser-performance-probe.js" open http://127.0.0.1:4178/auth/login
agent-browser --session "$SESSION" auth login "$PROFILE"
agent-browser --session "$SESSION" snapshot -i
```

Dismiss the introduction using the observed **Skip for now** button. Use the
`history-01` URL from metadata for one excluded smoke request, verifying a complete
reply and warming the API. Leave all other histories unchanged. Then:

```sh
node apps/web/scripts/run-browser-performance.mjs "$METADATA" "$SESSION"
node apps/web/scripts/run-browser-cold-load.mjs "$METADATA"
```

Do not run other builds/tests/browser automation concurrently with measurements.
The warm runner consumes ten histories; restart the fixture and authenticate again
before repeating it. Each runner prints an artifact directory. Cold cookie files
are private and removed in `finally`; after an interrupted/killed run, clean only
its exact owned cookie file/session, never unrelated browser state.

After measurements, close only `$SESSION`, delete only `$PROFILE`, and stop both
owned previews and the fixture. Unlink the two owned dependency symlinks before
`git worktree remove "$BASELINE"`; preserve unrelated worktrees and files.

## Cleanup and validation

Send SIGINT or SIGTERM to the fixture process. It closes both servers, aborts active sockets, closes the API SQL client, calls `fixture.destroy()` for its exact owned database, and removes its owned temporary directory. Startup failures after the helper returns follow the same cleanup. It never scans/drops databases by prefix or touches Redis.

**Shared-helper limitation:** `test/live-postgres.ts` does not return a cleanup handle if migration itself fails after database creation. Such a failure can leave its random database/client behind; SIGKILL or loss of PostgreSQL can also prevent cleanup. Use the dedicated disposable PostgreSQL instance above, and reset that instance if necessary. Do not compensate with a wildcard drop against a shared server. This fixture does not modify that existing helper.

Targeted checks (no database or long-lived fixture needed):

```sh
pnpm exec biome check apps/api/test/browser-performance/
pnpm --filter @oci/api exec tsc --noEmit -p test/browser-performance/tsconfig.json
pnpm --filter @oci/api exec vitest run test/browser-performance/fixture.test.ts
```

Tests cover URL safety, SSE framing, AI SDK consumption, non-stream responses, model validation, and cancellation using short-lived loopback servers on ephemeral ports. Browser login and full database startup are deliberately left to the caller.
