# Application review: chat performance and remaining risks

Branch: `review/chat-performance`. Baseline: `fd4cfa0`.

This is a source review plus a bounded frontend performance change, not a
security certification. Share-link privacy, retention bookkeeping/batching,
required email verification, background-job lock ownership, and chat admission
are now **fixed and covered by live PostgreSQL regressions**. Other backend
findings remain **unfixed**. The upload-quota follow-up is implemented and tested;
independent review's account-deletion lock inversion is fixed and regression-tested.
Transactional accounting is implemented with live failure-injection coverage;
both independent-review findings were fixed and verified. Remaining work and release gates are tracked in
[the execution plan](remediation-release-plan.md).

## Fixed: transcript work grows with every token and keystroke

Previously, `MessageList` extracted text, reasoning, sources and metadata and
rebuilt every message's Markdown on every parent update. Draft state lives in
`useChatSession`, so typing also took that path. Adding `memo` alone would not
work: the route and session supplied fresh action callbacks on each render.

Changes:

- `message-list.tsx`: 437 → 69 lines; owns ordering, the selected edit ID and
  waiting feedback, not every message's presentation and editor state.
- `message-row.tsx`: shallow-memoized row; unchanged historical message objects
  skip extraction and rendering. Row callbacks receive IDs inside the row,
  rather than being recreated in the list's map.
- Separate modules own actions/attribution, attachment cards, reasoning, text
  extraction and the editor. Each is under 100 lines. Editor keystrokes stay
  local, and successful edits close/reset rather than staying in saving state
  if the callback resolves without unmounting the transcript.
- `Markdown`, `Composer` and `ModelPicker` have shallow memo boundaries.
  Session and route callbacks have complete dependencies. Draft/model/file
  changes still update the relevant callbacks; token-only changes do not.
- User action rows without model attribution no longer subscribe to the model
  catalogue through an attribution component that returns nothing.

No deep equality, ignored callback props, unbounded global content caches,
stream throttling, or new Markdown block parser was introduced. Safety props
(`skipHtml`, `urlTransform`) participate in Markdown's shallow comparison.

### Repeatable work budget

The regression fixture mounts 100 historical messages plus one live assistant,
then replaces the active message 40 times. Counts exclude initial mounting.
The baseline tests were run before changing the transcript implementation.

| Scenario | Before | After |
| --- | ---: | ---: |
| Historical Markdown invocations during 40 updates | 4,000 | 0 |
| Total Markdown invocations during those updates | 4,040 | 40 |
| Markdown invocations across 20 unchanged parent renders, two-message transcript | 40 | 0 |
| Editing a user draft rerenders unrelated assistant Markdown | Yes | No |

These are component work counts, **not** a measured browser latency/FPS gain.
Tests stub the heavy renderer to isolate wrapper invocations. A separate test
exercises the installed AI SDK and verifies that streaming replacements retain
historical object identities. Another checks the lazy Markdown boundary and
changed safety props. DOM tests use a pinned `happy-dom` development dependency.

Run the guardrails through the normal CI test command, or directly:

```bash
pnpm --filter @oci/web test
pnpm audit:structure
```

The active reply still requires work proportional to its growing content, and
the list still maps message references on stream updates. Memoization does not
make transcript hydration, model prefill, layout or scrolling constant-time.

## Findings and remediation status

P1 means address before treating the application as ready for sensitive data or
multi-replica operation. P2 means correctness/resource problems needing a
follow-up with focused regression tests. Locations refer to this review's tree.

### Fixed P1 — Public links outlived retention deletion and thread expiry

Previously, retention updated the thread directly without revoking shares or
trashing attachments, and the anonymous reader checked only the link's state.

`share-link-availability.ts` now enforces live-thread and temporary-expiry
conditions. Creation and public reads hold a thread SHARE lock; deletion holds
an UPDATE lock. A deletion racing creation either rejects the creation or sees
and revokes its newly inserted link. Public reads reject legacy deleted threads
even if their links were never revoked. Missing temporary expiry fails closed.

The final view-count update checks availability in both WHERE and RETURNING.
The live lock-wait test demonstrated why: WHERE can pass before a lock wait and
not be reevaluated after time elapses. RETURNING uses `clock_timestamp()`, not
transaction-start `now()`, and an expired result rolls back the counter and
returns no content.

`lifecycle/trash-thread.ts` owns shared transactional deletion bookkeeping:
revocation, attachment trash state, storage counters and child lineage. Retention
filters eligible rows before its deterministic 500-row limit, locks them with
SKIP LOCKED, and runs that same bookkeeping. Live testing also exposed invalid
array interpolation in the existing attachment delete/restore updates; both now
use Drizzle `inArray`.

### Fixed P1 — Restoring a thread re-enabled revoked public URLs

Restoration no longer clears share revocations. Both explicitly revoked links
and links revoked by deletion stay revoked. Re-sharing requires a **new URL**;
restoring private history is not permission to republish it. Original explicit
revocation timestamps are preserved. Restoration also revokes any legacy links
that old deletion paths failed to withdraw. Delete/restore lock the thread before
bookkeeping so duplicate requests cannot adjust attachment counters twice.

### Fixed P1 — Required verification failed open, and signup issued sessions without proof

Verification policy no longer depends on SMTP availability or falls back to
false when settings cannot be read. Missing or malformed policy values fail
closed too: only a literal boolean `false` is an opt-out. The focused `auth/email-verification.ts`
callback leaves accounts unverified after missing configuration or rejected
delivery. Administrator-created accounts and invitation redemption no longer
mark recipients verified when a verification request throws.

Real Better Auth + PostgreSQL baseline tests exposed another bypass: signup
issued a session **even after successful delivery** with verification required.
The hook returned options at the wrong context level. The corrected request-local
`{ context: { context: { options: ... } } }` override reaches the installed SDK;
required signup now returns a null token, no session cookie and no persisted
session. Concurrent administrator recovery does not mutate that shared policy.
The SDK also checks the password before returning `EMAIL_NOT_VERIFIED`; the
redundant pre-password rejection was removed so wrong passwords do not disclose
whether the address belongs to an unverified account.

The public status endpoint reports the configured requirement even without
SMTP. Signup uses the actual response token rather than stale bootstrap settings.
Signup, invitation confirmation and refused unverified sign-in offer resend.
Resend does not confirm successful delivery. Policy is validated before account
lookup and carried into the delivery callback as a request-local snapshot, avoiding
an account-dependent second read that could fail mid-request. Delivery failures
receive the usual generic acknowledgement.

Only already-verified administrators retain the existing local-auth/settings
recovery exemption. Explicitly disabled verification still grandfathers new
local accounts. Existing verified flags and sessions are **not** reclassified:
operators should review historical accounts created under the old failure
fallback, which left no reliable proof-of-verification distinction.

### Fixed P1 — Job advisory locks did not own a database connection

`services/jobs/lock.ts` now owns the connection and lock lifetime; `runner.ts`
owns scheduling and run records. Each attempt reserves a connection from a
private single-connection client, uses that owner for acquisition and release,
and closes the client on every path. The cleanup boundary surrounds the entire
recorded job, including the initial run-record insert.

A local in-flight guard skips duplicate ticks without opening more clients.
Separate lock clients avoid exhausting the work pool when several different
jobs start together; a live test runs four jobs through a one-slot work pool.
Unlock exceptions, false responses, or a five-second unlock timeout lead to
private-client disposal, never reuse in the application's pool. The client
shutdown wait is bounded to one second. Original `hashtext` keys are preserved.

Independent review found that Postgres.js 3.4.9's timeout only ended the writable
side of its socket, so a stalled peer could leave connections accumulating after
cleanup returned. A pinned [driver patch](../../patches/README.md) makes the
forced shutdown path destroy the socket in both ESM and CommonJS builds, without
changing graceful shutdown. Local TCP transport regressions failed against both
unpatched builds and now check actual socket destruction, not just an `end()`
call. Docker build stages include the patch before dependency installation.

Three live baseline regressions demonstrated reentrant overlap, wrong-session
unlock and leaked locks after failed run-record inserts. Tests also cover failed
job bodies and status writes, independent module-local replicas, an external
owner, and PostgreSQL returning errors/false from unlock. Unit tests inject
reservation, acquisition, release, disposal and timeout failures.

This is **session-lifetime mutual exclusion, not exactly-once scheduling or
fencing**. Staggered ticks can run sequentially; losing the owning database
connection can release the lock while external work continues. Jobs still need
safe retries. Transaction-mode poolers are unsupported. Budget one additional
connection per concurrently attempted job per API replica, outside the normal
work pool; see [operations](../admin/operations.md#maintenance).

### Fixed P1 — Chat admission followed persistence and the fallback raced

`setup-turn.ts` now acquires admission before `prepare-turn.ts` reads history or
allocates attachments. In a short transaction, `thread-claim.ts` locks the owned,
live thread, rejects any streaming assistant and inserts a parentless assistant
placeholder whose ID is the run ID. This is the durable claim in **every Redis
mode**, including changes in Redis availability between requests.

The transaction ends before search, file loading, settings or quota work.
Preparation excludes its own placeholder from history. `persist-turn.ts` uses a
second short transaction to revalidate the thread and claim, lock uploads in
stable ID order, and save user/assistant positions, parentage, attachment links
and title atomically. Reuse of one upload across different threads admits only
one allocation; failed persistence rolls the entire turn back.

Failed setup deletes only its owned, parentless streaming placeholder, never a
user message whose attachments would cascade-delete. Committed turns retain the
existing failed-assistant behavior. An ambiguous commit leaves its claim blocked
rather than guessing. Successful terminal assistant persistence releases the
claim as part of that row's status update; failed persistence leaves it blocked.
Redis finalization and failed-begin cleanup use atomic token-checked deletion,
so a late cleanup cannot delete a successor's active pointer.

There is **no 15-minute takeover**. A slow producer is not proof of a crash.
Uncertain/orphaned streaming rows require operator recovery after stopping their
producer. Drain old API producers before deploying the new admission protocol;
old versions do not honor the thread-row lock. See
[chat recovery](../OPERATIONS.md#recovering-an-interrupted-chat-run). Bounded model
context, historical attachment reconstruction and transactional usage settlement
are covered below.

### P2 — Other backend correctness and scale issues

| Finding and source | Required follow-up / regression |
| --- | --- |
| **Fixed:** Parallel uploads exceeded storage allowance. | `attachments/upload.ts` now reserves capacity under a PostgreSQL usage-row lock before blob I/O. Pending uploads are hidden and protected from orphan cleanup. Restore enforces the same allowance; deletion/cascades and reconciliation preserve counters. Twenty-two live PostgreSQL/local-blob regressions pass, including failure/ambiguity injection. See migration `0020_atomic_upload_admission` and the interrupted-upload recovery procedure. |
| **Fixed; review findings regression-tested:** Unbounded provider history and aggregate input. | `context-history.ts` bounds database payloads independently of transcript pagination. `context-budget.ts` and `model-context.ts` reserve explicit output space, retain a contiguous whole-turn suffix and inspect attachment lengths before materializing selected files. Required latest/system/search content cannot be silently dropped. A persisted UI notice identifies omitted history. Estimates are deliberately not provider-exact tokenization; preparation/prefill latency remains unmeasured. Anthropic thinking expansion was reproduced at the real adapter boundary and fixed with a pre-persistence total-output plan; a follow-up alias-order finding also has a failing-before/passing-after wire regression. |
| **Fixed and independently verified:** Attachment context disappeared after the first response and on regeneration. | `chat/attachment-context.ts` reconstructs canonical live owned references, including copied forks, without persisting enrichment or following arbitrary URLs. Twenty PostgreSQL/local-blob/real-SDK-conversion cases cover text/PDF/image follow-ups, exact regeneration, policy, deletion/expiry races, reader concurrency and purge safety. Two additional lock-order regressions cover account deletion and ordered source trash. Hard-purge and account-deletion deadlocks were reproduced before fixing. Input budgeting is also validated at the later checkpoint below. |
| **Fixed; independently reviewed:** Stream replay could start mid-protocol after trimming roughly 10,000 events. | Versioned monotonic sequences now detect missing prefixes/ranges before forwarding bytes. Expired/legacy/failed caches emit a valid SDK error with saved-history reload guidance, without aborting generation. Atomic append validates metadata/TTL and propagates command errors; pull-based replay buffers one batch. Eight real Redis/SDK regressions failed before fixes; thirteen cases now pass, including idle tailing and backpressure. Checkpoint `proc_f717`: 583 scoped API, normal API 402, frontend 140, build/typecheck/coverage/lint/licenses/diff checks pass. |
| **Fixed:** Settlement could commit the event without its daily rollup. | `quota/settlement.ts` commits both together. All runs reserve an identity; duplicate measured reports are no-ops, while unknown usage can be amended. Sweeping is bounded and skips active claims. Unknown reports retain estimated allowance without putting estimates into measured rollups. Twenty-seven live cases cover concurrency, injected rollback/lost replies, amendments, release safety, account deletion, large counters and quota enforcement. Review-found partial-report loss after sweep and premature pruning of unknown events both failed before their fixes and pass afterward. Historical losses are not automatically repaired. |
| **Fixed:** Retention could starve eligible threads by limiting arbitrary live rows before applying inactivity/pinned predicates. | Eligibility now precedes the limit; live tests cover 501 exempt/active rows and progression through 501 eligible rows in bounded batches. |

Paths in this table are relative to `apps/api/src/`.

### P2 — Frontend failure and latency paths remain

- **Fixed and independently verified: thread loading/recovery.**
  Loading, unavailable (401/403/404), paused and transient-error states now have
  explicit boundaries and retry/navigation actions. Failed loads do not mount
  stale conversations or consume pending handovers. Reconnect and canonical
  hydration are serialized; drafts survive, pending reply prefixes remain visible,
  and stale reads cannot overwrite newer turns. Healthy replies avoid full-history
  refetches. Handovers are destination-scoped and loader state is keyed by thread.
  Review-found recovery-intent, StrictMode handover and reader-cleanup races plus
  Stop-before-headers were reproduced in five failing real-SDK cases and fixed.
  Independent read-only verification found no concrete new scoped regressions.
  Checkpoint `proc_151a`: 583 scoped API, normal API 402, frontend 181;
  build/typecheck/coverage/lint/licenses/diff checks pass.
- **The initial bundle eagerly includes admin/settings routes.**
  `apps/web/src/router.tsx:14–48` statically imports these pages. This branch's
  production entry is approximately 1,104 kB minified / 313 kB gzip. Route-level
  splitting is a better startup experiment than sprinkling more `useMemo` calls.
  Preserve auth/loading/error boundaries and measure cold-load typeability.
- **Implemented; independent review pending: next-turn uploads.**
  Submission snapshots IDs/cards and consumes only files acknowledged by the
  accepted response, rather than clearing the queue when streaming finishes.
  Rejected files remain available; new ready/pending files and previews survive.
  Regeneration excludes queued files. Canonical recovery reconciles uncertain
  allocation using persisted user references, not assistant output. Seven
  real-SDK baseline failures are fixed; ten upload cases now pass. A related
  immediate-retry ID mismatch was reproduced and fixed with a canonical prompt-ID
  response header. Checkpoint `proc_8035`: 584 scoped API, normal API 403,
  frontend 195; build/typecheck/coverage/lint/licenses/diff checks pass.

## “No hell files”: next boundaries, not arbitrary line limits

The existing `audit:structure` script is the repeatable inventory. No leaf API
routes import sibling routes. Do not split the 1,488-line model catalogue merely
because it is data-heavy. Do not recombine the existing chat services.

Worth focused follow-ups:

- Model picker: separate model option/details presentation from interaction and
  geometry ownership. Keep focus, portal positioning and filter behavior tested.
- Composer: separate option controls from input behavior, with keyboard/IME and
  textarea-resize tests before changing event handling.
- Quota reservation: distinguish admission from transactional settlement/sweeping.
- Stream store: distinguish Redis connection ownership, capture and replay.
- Usage reporting: split query domains when modifying reporting behavior.
- Branding/usage/general-settings JSX is long; inspect state ownership rather
  than treating every long component as defective.

## Applying the linked performance article

[How we made Claude faster](https://claude.dev/blog/how-we-made-claude-ai-faster/)
emphasizes measurable journeys, deterministic work counters and small protected
changes. This branch applies the render-count approach, not its reported speedups.

Next experiments, after the P1 fixes:

1. Measure cold load → typeable composer, new conversation → usable composer,
   conversation selection → painted transcript, and send → first visible output.
   Separate network/provider timing from React/paint timing. Never log message
   content, attachment names, prompts or credentials in performance telemetry.
2. Correlate the render-count reduction with real-browser traces using short and
   long transcripts, code/math/reasoning, desktop/mobile and CPU throttling.
   Record long tasks, commits, layout work and input responsiveness, not only
   total stream duration. No real-browser latency baseline was collected here.
3. Lazy-load non-chat routes; measure before considering hover-prefetching.
   Do not share conversation caches across users or revive expired/deleted data.
4. Profile growing Markdown separately. The existing Streamdown renderer already
   owns parsing; do not split arbitrary blank-line blocks and break tables,
   references, fences or math. Consider worker highlighting only with evidence.
5. Consider windowing only after measuring large transcripts, with explicit
   selection, find-in-page, accessibility and scroll-anchor tests.

## Validation

Bounded-input checkpoint (`proc_27ca`): 570 scoped API tests, normal API 389,
140 frontend tests, eight build/typecheck tasks, coverage floors, lint, licenses
and diff checks pass. This includes 25 real PostgreSQL/local-blob input cases,
18 pure budget cases, 34 real Anthropic-adapter request-body cases, and an SDK
context-notice persistence regression. Independent review identified the
Anthropic expansion; scoped follow-up verification confirmed normal model paths
and identified the now-fixed compound-alias precedence edge. No provider calls
were made by those adapter tests. Ready-content immutability is an assumption
for retrieval bounds: corrupted/out-of-band payload growth can consume more
memory before rejection. Accepted input ceilings are not hard RSS guarantees.

Historical attachment checkpoint: 492 scoped API tests (none skipped), 139
frontend tests, coverage floors, fresh build/typecheck, lint and licenses pass.
Includes 20 historical-context and two lock-order cases. Final independent
verification found no blocking scoped findings. Subsequent input-budget changes
are not covered by that checkpoint.

Accounting checkpoint: 470 scoped API tests (none skipped), including 27 live
accounting cases. Settlement/sweep coverage floors, build/typecheck, lint,
licenses and 139 frontend tests pass. Both independent-review findings were
reproduced in PostgreSQL and fixed; independent verification found no new scoped
regressions.

Upload-admission checkpoint: 442 scoped API tests (none skipped), 139 frontend
tests, fresh build/typecheck, lint and coverage floors pass. The normal API suite
passes 335 tests. The preceding admission-only checkpoint is recorded below.

- Fresh, cache-bypassed builds and typechecks pass. API and web Docker build
  stages pass with frozen dependency installation and the pinned driver patch;
  the 14 lock-unit/transport tests also pass in the Linux API build container.
- Web: 139 tests pass, including 12 new render/identity/correctness tests and
  seven verification/resend UI tests.
- API: 335 normal-suite tests pass with disposable Redis available, including
  the previously skipped Redis suites and three new ownership/metadata tests.
- Lint and dependency license policy pass; `pnpm audit --prod` reports no known
  vulnerabilities. Large-bundle warnings remain.
- Share-privacy follow-up: 19 new live PostgreSQL tests exercise real services
  and anonymous routes in throwaway databases. Coverage includes lifecycle
  availability, restoration, ownership, attachment accounting, retention rollback
  and batching, plus multi-connection creation/deletion, revocation and expiry
  races. All six related PostgreSQL suites pass (44 tests). Settings are stubbed;
  the new storage-accounting cases use metadata fixtures, not uploaded blobs.
- Auth follow-up: 20 new live PostgreSQL tests use the real Better Auth HTTP
  handler and email service with injected Nodemailer delivery results. They
  cover failed/missing delivery, null signup sessions, resend and real token
  redemption, policy outages and missing real settings rows, request-local
  policy snapshots, password-before-verification ordering, verified-admin
  recovery, concurrent requests, administrator provisioning and invitation failures. Three baseline regressions
  were demonstrated before the fix; the existing three admin-role live tests
  also pass.
- Job-lock follow-up: 12 unit tests, two local TCP transport regressions and ten
  live PostgreSQL tests pass. The three
  original ownership/cleanup failures were reproduced before implementation.
  `services/jobs/lock.ts` has 100% statement, branch and function coverage, with
  matching per-file coverage floors.
- Chat-admission follow-up: 21 live PostgreSQL route tests cover same-thread
  contention, real Redis ownership and simulated availability changes, concurrent
  fallback submissions, rejected setup, transactional rollback, upload reuse and
  revalidation, expiry/deletion, regeneration, old streaming rows, and preparation
  through a one-slot database pool. Provider invocation is a stub; no model API
  requests are made. Attachment metadata is real, but loading bytes is stubbed.
  Without Redis, the suite passes 17 tests and skips its four Redis-only cases.
- Scoped API coverage (normal suites, share suites, attachment routes,
  auth/provisioning, job-lock and chat-admission live suites): 420 passed, none
  skipped with PostgreSQL and Redis available; all coverage thresholds pass. Share service coverage remains 90%
  statements / 89.47% branches / 100% functions.
- No live provider requests, authenticated browser suite, real SMTP server/network
  fault exercise, or production load testing were run.
- Frontend, share-privacy, verification, job-lock and chat-admission changes are implemented. Findings not
  marked fixed remain a remediation backlog, not claims that the whole
  application is fixed.

Run the new live suites against a disposable PostgreSQL server with database
creation privileges (each suite migrates and drops its own random database):

```bash
TEST_DATABASE_URL=postgres://USER:PASSWORD@127.0.0.1:PORT/DATABASE \
  pnpm --filter @oci/api exec vitest run \
  src/__tests__/live/share-lifecycle.live.test.ts \
  src/__tests__/live/share-lifecycle-races.live.test.ts \
  src/__tests__/live/email-verification.live.test.ts \
  src/__tests__/live/admin-create-roles.live.test.ts \
  src/__tests__/live/job-locks.live.test.ts \
  src/__tests__/live/chat-admission.live.test.ts
```

Without a reachable test database, live suites skip; a skipped run is not evidence
that these privacy boundaries passed.
