# Remaining remediation and release

Branch: `review/chat-performance`; earlier review evidence is in
[chat-performance-review.md](chat-performance-review.md).

The owner authorized completing the remaining items in order, then committing,
tagging, pushing the release, and updating homelab **only after validation passes**.
Do not discard earlier work, release from a dirty tree, reuse a published tag, or
replace the deployment before both versioned images and release validation pass.

The owner subsequently requested **commit, push, continue**. Validated checkpoint
commits may be pushed to this review branch before every release gate is finished.
That is not authorization to tag, publish a release, or deploy incomplete work.

## Current checkpoint

`proc_4ba2` passes: 584 scoped API tests, normal API 403, frontend 215, eight
build/typecheck tasks, production route graph gate, coverage floors, lint, licenses
and diff checks. Earlier work is committed/pushed as `f056f41` (not a release). Upload
acceptance changes are implemented, tested, and independently reviewed without
concrete scoped findings.
The remaining execution/release gates below still apply.

## Execution order

1. **Atomic upload quotas — complete.**
   Durable reservations precede object I/O. Restore observes the same allowance;
   deletion/cascades and reconciliation preserve counters. Twenty-two new live
   PostgreSQL/local-storage tests; 442 scoped API tests and coverage floors pass.
   Build, typecheck, lint and 139 frontend tests pass. Review's account-deletion
   lock inversion reproduced as PostgreSQL `40P01`; parent-first locking now
   passes the forced-overlap regression. Object failures/ambiguous replies are
   injected; this does not claim S3 network-failure coverage.
2. **Transactional usage settlement and rollup — complete.**
   Every run reserves a durable identity, including unlimited runs. Event and
   rollup writes commit together; unknown reports retain estimated allowance and
   permit one later complete amendment. Sweeps are bounded and skip active
   claims. Migration `0021_usage_settlement` adds uncertainty tracking and bigint
   daily token counters. Twenty-seven live accounting cases bring the scoped API
   suite to 470 passing tests; new settlement/sweep coverage floors pass. The
   latest full checkpoint also passed 139 frontend tests, build/typecheck/lint
   and licenses. Both independent-review gaps were reproduced before fixing:
   partial reports now merge idempotently after sweeping, and retention preserves
   unresolved identities/prices until reconciliation. Independent verification
   confirmed both fixes with no new scoped findings.
3. **Historical attachment context for follow-ups and regeneration — complete.**
   Reconstruct canonical owned/available file references from stored user turns,
   preserve copied fork references, and revalidate historical files at commit.
   Provider input must not follow arbitrary stored URLs or persist model-only
   extracted text/data URLs. Twenty context cases and two lock-order cases pass.
   Baselines reproduced account-deletion and hard-purge deadlocks (`40P01`), plus
   unordered source-file locking. Parent-first chat and sorted trash-file locks
   are implemented; historical validation uses compatible shared reads with
   fail-fast conflict handling. All 492 scoped API tests, 139 frontend tests,
   coverage floors, build/typecheck/lint/licenses pass. Independent verification
   found no blocking findings in the scoped lock fixes.
4. **Bounded model input history — complete.**
   Provider input is bounded independently of transcript pagination. Required
   latest/system/search content is retained, output space explicitly reserved,
   whole recent turns selected, and file sizes inspected before payload loading.
   Omitted history gets a persisted reply notice; estimates are not exact tokens.
   Twenty-five PostgreSQL/local-blob cases and eighteen pure budget cases pass,
   including real SDK conversion and a separate SDK notice persistence regression.
   Checkpoint `proc_441b`: 534 scoped API tests, normal API 355, frontend 140,
   coverage floors, eight build/typecheck tasks, lint/licenses/diff checks pass.
   A preceding coverage-floor failure was addressed with meaningful policy,
   metadata-change, actual-size-mismatch and regeneration regressions; no existing
   floor was lowered. Independent review then found Anthropic's adapter adds its
   thinking budget to the requested answer cap. Three adapter-level baselines
   reproduced expansion (Sonnet 4 high: 4,096 reserved → 42,496 upstream).
   `generation-settings.ts` now splits legacy thinking/answer within the reserved
   total before persistence; adaptive controls remain intact. Wire-format and
   pre-persistence regressions pass. The SDK version is gated by an upgrade-review
   assertion. Scoped verification confirmed ordinary-model behavior and found one
   compound gateway-alias ordering mismatch. Its wire regression failed before
   restoring exact SDK classification precedence and now passes (34 adapter cases).
   Final checkpoint `proc_27ca`: 570 scoped API tests, normal API 389, frontend 140,
   eight build/typecheck tasks, coverage floors, lint, licenses and diff checks pass.
   Resource caveats are explicit: out-of-band blob/metadata divergence can exceed
   accepted limits in retrieval memory before rejection; these are not reported
   as hard peak-memory guarantees.
5. **Truncated stream replay — complete.** Explicitly handle missing protocol
   prefixes and validate recovery through the real SDK parser. Planned: versioned
   monotonic event sequences, atomic append/expiry validation, command-error
   detection, and backpressure-aware replay that checks every sequence before
   emitting bytes. Missing/truncated/legacy cache should emit a valid SDK error
   with canonical-history reload guidance, never orphan deltas. Replay failure
   must not abort the producer, remove its admission claim, or stop final message
   persistence. A dedicated Redis + real SDK transport/parser regression suite
   reproduced eight failures before production edits (two valid/ownership cases
   passed). Thirteen real Redis/SDK cases now cover initial/midstream gaps,
   expiry, command errors, failed-capture markers, idle tailing and backpressure.
   Checkpoint `proc_f717`: 583 scoped API, normal API 402 and frontend 140 tests;
   coverage floors, eight build/typecheck tasks, lint/licenses/diff checks pass.
   Independent read-only review found no actionable scoped regressions; the
   latest append-error marker is covered by the full passing run above.
6. **Thread-load error/not-found states and recovery — complete.** Include canonical-message
   recovery when replay is unavailable or finishes between initial history load
   and reconnect, and retain a stop action for a known server-side active run.
   Implemented and validated: explicit loading/unavailable/
   retry states; serialized SDK reconnect and canonical recovery; stale-response
   guards and pending-prefix preservation; browser-only cleanup on navigation.
   Healthy replies do not refetch entire transcripts. Scoped handovers prevent
   failed-load navigation from sending a pending prompt into another thread.
   Seven loader baseline failures reproduced; an additional cross-thread upload
   carry-over failure reproduced before keying loader lifetime by thread.
   Expanded checks include 13 loader, 15 direct real-SDK recovery, 10 session/
   transport, three homepage handover, and two existing render/callback tests.
   Review found stale recovery intent could erase a newer rejected prompt,
   StrictMode cleanup could abort one-shot handovers, and resumed browser readers
   survived navigation. These plus Stop-before-headers failed in five real-SDK
   baselines, then passed after request-scoped intent and scope-owned abort/
   lifetime-safe cleanup fixes. An additional injected DELETE-failure case checks
   local reader closure without falsely declaring the server run stopped.
   Checkpoint `proc_151a` passes after the race fixes: 583 scoped API tests,
   normal API 402, frontend 181, eight build/typecheck tasks, coverage floors,
   lint/licenses/diff checks. Independent read-only verification confirms the
   targeted fixes, with no concrete new scoped regressions.
7. **Next-turn uploads — complete and independently reviewed.**
   Snapshot request IDs/cards, consume only accepted files, retain rejected files,
   leave pending next-turn uploads/previews alone, and exclude new files from
   regeneration. Canonical user references reconcile ambiguous acceptance without
   trusting assistant output. Seven failing real-SDK baselines now pass; ten upload
   cases cover ready/pending files, rejection, previews, regeneration, handovers,
   and ambiguous replies. Immediate retry also exposed a browser/server prompt-ID
   mismatch: the real SDK HTTP response now carries the saved prompt ID, which
   updates the optimistic user row without refetching the entire history. The
   failing-before/passing-after retry regression and API header test both pass.
   Read-only independent review confirmed snapshot isolation, acceptance-bound
   consumption, regeneration exclusion, prompt identity and guarded canonical
   reconciliation; no concrete scoped findings.
8. **Lazy admin/settings routes — implemented and validated.**
   Page/layout imports are deferred; eager session/admin guards remain in place.
   Navigation metadata no longer imports the admin layout through the command
   palette. Pending UI is accessible and route errors expose generic reload/home
   actions, not raw exceptions. A production manifest/source-map gate checks the
   entire static import graph; six fixture tests pass, and the gate rejects an
   actual eager build of checkpoint `f056f41`. Initial JavaScript changes from
   1,114,040 to 873,266 bytes (gzip level 9: 312,362 to 272,774 bytes). However,
   initial JS files increase from 2 to 58; this is not a browser-latency result.
   Production build/graph gate, 201 existing/graph tests and the Linux web build
   stage pass (`proc_6f3a`). Fourteen additional real-router cases check import
   factories, direct links, guards/redirects, controlled loading, safe errors/reload
   and dynamic parameters (page/layout bodies mocked). Parent corrected a fixture
   hook-placement lint issue, reran all 20 routing/graph cases, and passed the full
   checkpoint above. These are the original phase-eight measurements; phase nine
   below subsequently consolidated initial shared code without eager route loading.
9. **Real-browser responsiveness and long-response measurements — complete;
   local scope and tradeoffs documented.**
   [Method, results and limitations](browser-performance.md): original `fd4cfa0`
   versus the remediated frontend, same real API/auth/disposable PostgreSQL and
   local synthetic provider. Initial cold testing exposed a 58-chunk startup
   regression. Grouping only initial shared modules leaves three startup files;
   repeat cold medians improve composer DOM readiness 163.7 → 148.4 ms and JS
   transfer bytes 311,683 → 258,173 (five trials each). Four unprofiled long-history
   trials per build plus two traces show similar typing responsiveness and reduced
   JS work, not reduced layout. First response DOM text is about 50 ms later in
   the candidate: not a uniformly faster result. All ten final streaming trials
   preserve drafts/render complete fixture output without observed page errors.
   Real admin/models and settings/account browser smokes also pass. No INP,
   production latency, mobile/load or RSS claim. Sixteen fixture contract tests
   pass. Checkpoint `proc_da24`: 600 scoped API tests (including 16 fixture tests),
   normal API 419, frontend 215, eight build/typecheck tasks, coverage floors,
   production graph gate (3 files / 860,995 bytes), lint, licenses and diff checks
   pass. The Linux web build stage also passes with the same three-file graph
   (`proc_b013`). Independent read-only review cross-checked the artifacts and
   found no actionable isolation, correctness or evidence-claim issues.
   This is not the broader phase-twelve release gate.
10. **Focused Composer/ModelPicker/backend boundaries — checkpoint validated.**
    Migration session ownership/cleanup and report arithmetic defects have
    real-PostgreSQL regressions and targeted fixes (details below). Reporting
    query-domain extraction is verified. Thirty real-component Composer/ModelPicker
    interaction cases now pass, including fixes for two IME Enter submission bugs
    (28-pass/two-fail baseline `proc_3287`, green `proc_629f`). Composer option/file
    controls and ModelPicker option/details presentation now have separate modules;
    textarea submission and picker focus/geometry remain in their controllers.
    Parent-reviewed changes preserve DOM order, callbacks and memo boundaries.
    Latest checkpoint: 706 scoped API tests with coverage floors (including new
    deadline/status-reader ratchets), eight build/typecheck tasks, 459 normal API
    tests, 246 web tests, lint/licenses/diff all pass (`proc_7f3a`). Linux API
    runtime/build and web build images pass (`proc_cf09`, refreshed API
    `proc_162a`); 57 Linux migration/replay/transport regressions pass. Non-root
    bundled-runtime migration/readiness/concurrent-replica checks also passed
    (`proc_2213`, exact disposable database removed; migration runtime unchanged
    by the later replay correction).
    Independent reviews prompted a real migration reconnect probe and a healthy
    replay-completion race regression. Both are reproduced and corrected (details
    below). Migration review now finds no production blocker; nontransactional
    DDL-start evidence plus a rollback control close its observation gap. Final
    replay-correction review finds no blocker in bounded terminal reconciliation,
    actual finish-frame proof, missing-owner isolation or route status wiring.
    These are scoped source reviews, not additional test executions. Broader
    release gates remain open.
11. **Historical verification — source review complete; owner decisions open.**
    [Evidence assessment](email-verification-provenance.md) compares `fd4cfa0`
    with `6257862` and the pinned SDK. Flags, timestamps, SSO links and generic
    HTTP-outcome audit events cannot reliably classify all accounts. Token-error
    redirects may even be named verification successes. No production accounts,
    credentials or sessions were accessed or changed. Production evidence scope,
    accepted proof and handling of unknown provenance require owner approval;
    there is no blanket flag/session reset or inferred historical repair.
12. Full authenticated browser, live service, migration, build/typecheck, lint,
    coverage, audit, license and release validation; final independent review.
13. Organize and commit changes; prepare a new semver version/changelog; integrate
    through the repository's main/release process; tag and push only passing code.
14. Verify published API/web images, stage/smoke-test, back up homelab data/secrets,
    drain old producers, apply migrations once, update homelab with a pinned image
    pair, verify readiness/login/chat/attachments, and retain a rollback plan.

## Working infrastructure

Disposable Compose project `oci-remediation`, defined in
`/tmp/oci-chat-admission.compose.yaml`, currently uses PostgreSQL on
`127.0.0.1:55441` and Redis on `127.0.0.1:6389`. Tests create and drop isolated
PostgreSQL databases. Do not stop or modify unrelated local infrastructure.

## Release/deployment gates

Follow [RELEASING](../RELEASING.md) and [OPERATIONS](../OPERATIONS.md). Discover the
homelab checkout and its deployment mechanism read-only before modifying it.
Confirm branch protection/CI and registry package visibility; preserve private
packages. Do not disclose deployment secrets in logs, docs or commits.

Homelab discovery found `/Users/nicholascecere/homelab/bitop-talos`, remote
`git@github.com:ncecere/homelab.git`, using Flux/Kustomize on Talos. App manifests
and a deployment README are under `kubernetes/platform/open-chat-interface/`;
Flux configuration is `kubernetes/flux/cluster/open-chat-interface.yaml`.
The current configuration pins API/web v0.4.1 images by digest. The checkout is
on `main` with unrelated modified Talos files and untracked backup tooling:
preserve these and stage only app deployment changes at release time. Discovery
was read-only; live cluster state and backups have not yet been verified.

Admission changes require drained old producers; rolling mixed old/new code is
not supported. Interrupted runs and uploads fail closed. Recovery procedures
are in OPERATIONS and require confirming the producer has stopped.

## Backend cleanup observations and evidence

- **Fixed, targeted validation passed:** cancellation's separate HGETALL/HSET
  recreated expired metadata with an immortal TTL (`PTTL=-1`) and could write
  into replaced ownership. Five real-Redis baselines failed, two controls passed.
  Atomic Lua now requires matching run/thread/user, active status and positive
  physical/logical lifetime, without refreshing TTL. The runtime wrapper also
  acknowledged requests that the store rejected; a further real-Redis race failed
  before that fix (`proc_5f52`). Ten cancellation cases plus existing stream/replay
  suites, typecheck and lint pass (`proc_f678`), including local fallback and remote
  acceptance controls. A later registry-overlap baseline (`proc_ce63`, ten controls
  pass/one failure) showed explicit Stop targeting an older terminal run still
  settling usage instead of its newer local producer. Selection now uses newest
  owned registration; eleven cancellation cases pass within `proc_56c6`.
  Acceptance still does not prove that a producer stopped.
- **Fixed recovery, targeted validation passed:** Redis cooldown can skip
  finalization after an append transport failure, leaving a stale active pointer
  despite a terminal PostgreSQL message. Real Redis baselines failed 11/12 cases;
  real PG/Redis route baselines failed 8/12. Only a successful durable claimant
  can now conditionally supersede stale cache indexing; ordinary cache-only
  admission still conflicts. Racing publication yields non-resumable fallback,
  and same-run retries preserve events/cancellation/TTLs rather than resurrecting
  missing or invalid state. Initial resume checks the exact owned assistant/run
  (terminal/missing → 204; validation failure → safe 503). Idle readers recheck
  every two seconds, with a two-second abortable reader deadline and one-second
  SQL statement timeout. Missing ownership/error ends only the replay reader with
  SDK-friendly error/DONE. An independent review exposed healthy completion
  during a status check or delayed finalization being mistaken for failure; both
  real-Redis baselines failed (`proc_d1d3`). Owned-terminal state now refreshes a
  fixed tail snapshot and closes cleanly only after a real finish frame has been
  forwarded; missing ownership never authorizes a new suffix. Incomplete snapshots
  still fall back to canonical history rather than chasing an unbounded cache.
  Real SDK encoder/decoder, completion-race, missing-owner and growing-cache cases
  pass with existing admission/recovery tests (122 cases, typecheck/diff,
  `proc_8162`). No claim takeover, age-based death inference, producer cancellation
  or automatic resend.
  The runtime cooldown case injects a transport-style failure before real Redis
  Lua: it is **not packet-loss evidence** or a guarantee of finalization during a
  partition. Real-SDK frontend coverage additionally verifies idle error closure
  precedes canonical hydration and preserves the next draft (`proc_39c1`).

- **Fixed, targeted validation passed:** `runMigrationsWithLock` used different
  PostgreSQL sessions for its lock and DDL, and leaked its migration connection
  after both commit and rollback. Two instrumentation controls passed while three
  production baselines failed. The first private `max:1`-client fix passed eight
  ordinary ownership/cleanup cases (`proc_63c3`), but **was not physically pinned**:
  terminating its idle lock owner let the real pool reconnect and execute 35
  observed CREATE TABLE statements without ownership (`proc_1949`, repeating the
  independent probe). The migrator now wraps lock acquisition, journal reads and
  DDL in a physical READ COMMITTED transaction. Its transaction-scoped lock lasts
  through outer commit/rollback; Drizzle's inner transaction becomes a savepoint,
  without copying unpinned pool query methods into the adapter. Disconnect now
  rejects before observed DDL. Controls also verify an overridden repeatable-read
  server default. All 19 reconnect/ownership/readiness/replica tests, typecheck and
  scoped lint pass (`proc_68a2`). Independent driver/adapter review found no
  production blocker, but transactional observation rows alone cannot exclude
  rolled-back DDL. A nontransactional sequence now counts DDL-start events; a
  rollback control proves that evidence survives abort. All four enhanced probe
  cases pass on macOS and Linux (`proc_74fc`, `proc_fce1`), with zero DDL starts
  following the injected disconnect. Build `@oci/db` before standalone API tests:
  imports resolve its built `dist`.
- **Fixed, targeted validation passed:** overall/daily/model/consumer token
  reports added int32 operands before SUM. Four valid PostgreSQL baselines failed
  with `integer out of range`; operands now widen before addition. Five new cases
  exercise two 1.5-billion input/output events (6-billion total tokens) and empty
  results. Original timezone/reporting tests remain unchanged and pass alongside
  them (11 reporting tests total). Reporting now has consumption, activity,
  storage, governance and common modules behind the unchanged public facade.
  Parent AST comparison verifies all 23 declaration bodies against the fixed
  pre-extraction snapshot (only sibling-private `rangeStart` gains `export`).
  Typecheck and scoped lint pass.
- **Fixed, targeted validation passed:** two real-PostgreSQL baselines showed
  `migrationsApplied()` accepted stale history and an unrelated future marker.
  Non-migrating startup now requires the exact latest bundled migration timestamp
  to be recorded. Five readiness cases cover current/missing/stale/history-ahead
  states; combined migration/readiness/replica checks pass (`proc_d86e`). This
  verifies required history, not physical schema integrity or rollback safety.
- **Fixed, targeted validation passed:** trash, restore and retention each
  deadlocked with account deletion while repairing a missing storage counter
  (`40P01`, three failing real-PostgreSQL races and three successful controls,
  `proc_9849`). Lifecycle mutations now lock the user parent before thread/file
  locks and counter insertion. Retention discovers at most 500 eligible candidates
  with nonblocking owner/thread locks, releases discovery locks, then rechecks and
  commits each thread separately in parent-first order. Busy owners are excluded
  before the limit, so one busy owner cannot hide other eligible owners. Completed
  threads survive an interrupted batch; retries do not double-adjust them.
  Nine new cases plus existing share/locking/storage suites pass (52 tests,
  `proc_39ff`), with typecheck and scoped lint. This is scoped lock-order evidence,
  not a proof that every lifecycle/deletion path is deadlock-free.
