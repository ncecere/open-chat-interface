# Maintainability review — September 2026

This review separates **module structure**, **behavioural defects**, and
**dependency advisories**. Passing the refactor's tests does not mean the project
has no defects or vulnerabilities.

## Repeat the structural inventory

```bash
pnpm audit:structure
pnpm audit:structure --json
```

The script uses the TypeScript parser to list source files of at least 400 lines,
functions/components of at least 150 lines, and leaf API routes importing other
routes. It excludes tests, declarations, and build output. It is a review aid,
not a CI size limit: a declarative catalogue and a large stateful controller are
not the same problem. A short file can still have poor boundaries.

## Boundaries changed

| Entry point | Before → after (lines) | Responsibilities extracted |
| --- | --- | --- |
| `apps/web/src/routes/admin/storage.tsx` | 834 → 60 | Draft validation/patching; save/health controller; driver, S3 credential/connection, and upload panels |
| `apps/web/src/routes/admin/sso-provider-form.tsx` | 880 → 181 | Validated create/edit payloads; policy and role mappings; OIDC/SAML field groups |
| `apps/web/src/routes/admin/users.tsx` | 521 → 126 | Directory filters/paging; saved views; selection/bulk actions; table and role mutation |
| `apps/web/src/routes/admin/audit.tsx` | 548 → 193 | Filter/query controller; desktop/mobile event lists; event details |
| `apps/web/src/components/command-palette/command-palette.tsx` | 424 → 133 | Role-aware action catalogue; debounced search and keyboard interaction |
| `apps/api/src/routes/chat.ts` | 569 → 86 | Server-owned turn preparation, persistence, run acquisition, streaming, and settlement |
| `apps/api/src/routes/admin/users.ts` | 426 → 54 | Listing, detail aggregation, account mutations, and bulk actions |
| `apps/api/src/routes/admin/quotas.ts` | 290 → 35 | Policy queries, assignments, and administration |
| `apps/api/src/routes/admin/overrides.ts` | 210 → 29 | Per-user override reads and mutations |

The goal is not to hide the old function behind an import. Each extracted module
owns a distinct part of the workflow. Services accept validated domain inputs,
not Hono contexts. Form panels still share their parent draft; switching tabs
must not discard edits or introduce independent saves.

Repeated API-error presentation and proxy-address parsing now have shared
implementations. General `Error` handling is deliberately not replaced by the
API-error helper: surfacing an arbitrary exception's message changes what a user
can see. Credential and settings-diff code is also not automatically generalized;
keep/replace/clear and field normalization are part of each form's contract.

Removed unused `listAudit`, `isSmtpConfigured`, and `activeStreamCount` service
exports, plus direct `nanoid` and Radix tooltip dependencies. Transitive versions
of a removed direct dependency may still exist in the lockfile.

## Long modules retained

- `packages/shared/src/model-labs.ts`: mostly static catalogue data.
- `apps/api/src/services/usage-report.ts`: related, individually scoped reporting
  queries rather than one large handler.
- Quota reservation and chat-stream persistence modules: cohesive lifecycles.
- Branding, usage, and general-settings pages: already separated into themed
  sections/components. Long JSX alone is not a reason to add indirection.
- The model picker remains a substantial interactive component. Its filtering
  and model-data helpers are already separate; positioning/focus changes need
  dedicated visual regression testing rather than a mechanical line-count cut.

Smaller files and thin routes are useful boundaries, not proof that complexity
has disappeared. Re-run the inventory when adding responsibilities to these
modules.

## Behavioural findings at the refactor boundary

These predated the refactor and were intentionally not changed while moving
code. The following list records the original findings; see the runtime
remediation below for their current status.

1. **Concurrent stream acquisition is not atomic in Redis.**
   `services/limits/concurrency.ts` counts active slots in one transaction and
   adds a slot in another. Two requests can both observe capacity. Use a single
   atomic script/operation and test competing requests at the cap.
2. **Quota policy edits can partially apply.**
   `services/quota/policy-admin.ts` writes the policy and role assignments before
   model validation; `policy-assignments.ts` deletes the old model scope before
   rejecting unknown slugs. Validate first and commit the replacement in a
   transaction; regression tests must check that rejected edits preserve all
   previous assignments.
3. **Creating an auditor does not preserve the requested role.**
   `services/admin-users/mutations.ts` passes only admin/user to Better Auth and
   only special-cases restricted afterwards. Auditor creation therefore needs a
   role-handling fix and a route-level test.
4. **Some chat setup failures leave state behind.**
   Inspect database-fallback lock lookup, assistant insertion followed by quota
   denial, and SDK message-conversion/stream setup failures. Each acquired slot,
   run lock, reservation, and assistant row needs an explicit failure lifecycle.
   Existing success-path tests are not sufficient to prove cleanup.

Session deletion also remains subject to Better Auth's existing cookie cache;
this refactor does not introduce immediate revocation or alter that policy.

## Runtime remediation

The separate runtime-safety change addresses all four findings:

| Finding | Change | Regression evidence |
| --- | --- | --- |
| Redis stream cap | One Lua operation prunes expired members, checks capacity, reserves the run, and sets TTL. Existing-run retries do not consume another slot. | Real Redis: 12 connections, 96 competing acquisitions, five rounds at each of three role caps; expiry, retry, and release tests. |
| Partial quota writes | Validate model scope before writes, then commit policy and assignments together. Existing-policy row locks serialize edits; success audit runs after commit. | 13 real PostgreSQL tests: invalid inputs, immediate and deferred insert failures, rollback, concurrent name conflicts/edits, scopes and deletion. |
| Auditor creation | Persist both non-built-in roles, auditor and restricted, after Better Auth creation. | Unit regression and four PostgreSQL route tests covering every role, persisted read-back and auditor read/write gating. Better Auth creation itself is stubbed in these tests. |
| Chat setup leaks | One cleanup boundary covers partial acquisition and SDK setup. Cleanup attempts are independent, preserve the original error and mark only the owned streaming assistant failed. Completion attempts quota settlement even if message persistence fails. Once SSE capture starts, it exclusively owns Redis finalization. | 14 fault-injection tests covering fallback lookup, insertion, quota refusal, conversion, SDK/response creation before and after capture starts, dual cleanup failures and successful completion. |

These are bounded guarantees, not a distributed-systems all-clear. Redis-down
behaviour remains local/fail-open and crashed slots expire after 30 minutes.
Cleanup cannot guarantee a database write during an outage; failures are logged.
Before SDK startup, failed setup releases the reservation. After SDK startup, a
response-construction failure counts the attempted message with unknown tokens
settled at zero, matching the existing failed-run policy. Model/SDK calls in the
fault-injection tests are mocked, not live provider requests. The existing
cookie-cache revocation delay is unchanged. Dependencies are handled separately.

Runtime-fix verification: build, lint, typechecks, license policy and version
consistency pass; 301 API unit/integration tests and 120 web tests pass. The API
coverage run passes its existing thresholds with 413 tests (including 112 live
PostgreSQL/SMTP checks) and six S3 checks skipped because the configured MinIO
image could not be pulled. An isolated API smoke also used **real Better Auth**
to create an auditor, read its persisted role, sign in, read admin users and
confirm a write returned 403. No browser suite or external IdP was run for this
backend-only remediation.

## Refactor verification and limits (historical)

- Build, lint, typechecks, release-version consistency, and license policy checks pass.
- API unit/integration: 277 passed; web unit: 120 passed.
- Live PostgreSQL: 89 passed; 12 SMTP/S3 tests skipped because those services were not running.
- Playwright desktop/mobile: 42 passed; two introduction checks skipped because
  the shared test account had already completed onboarding. New storage,
  OIDC/SAML form-payload, and cross-page user-selection checks all ran.
- The API reference still contains 114 routes across 27 handler files.
- A signed-in smoke test exercised quota policy creation, listing, update, and
  deletion against the isolated review database.

Review infrastructure used its own Compose project/volumes, not an existing
application database. Browser tests stub model responses and SSO provider
registration; they do not prove live model inference or an external IdP login.
No exhaustive security or accessibility conformance claim is made.

## Dependency scan (before remediation)

`pnpm audit --prod` on September 16, 2026 reported **20 advisory entries: 10 high,
10 moderate, no critical**. These are scanner findings, not 20 independently
verified exploitable vulnerabilities. Some paths contain optional test tooling.

| Package in reported paths | Installed | Patched version reported by scanner |
| --- | --- | --- |
| `@xmldom/xmldom` | 0.8.13 | 0.8.15 covers the reported set |
| `hono` | 4.13.0 | 4.13.5 |
| `nodemailer` | 9.0.1 | 9.1.1 covers the reported set |
| Transitive `nanoid` | 3.3.17 | 3.3.18 |
| `vitest`, `@vitest/mocker` | 3.2.6 | 4.1.11 |

Re-run the scanner before remediation; advisories and version availability can
change. Dependency upgrades belong in a separate branch with SAML, mail, HTTP,
and test-runner verification. Optional/dev paths need deployment reachability
analysis, not automatic dismissal. A successful SAST job or build is not evidence
that these findings have been resolved.

### Subsequent dependency remediation

The separate dependency change upgrades the packages above and reports zero
advisories in both production and full audits, without ignored findings. See
[dependency remediation](dependency-remediation.md) for versions, reachability
limits, coverage changes and the repeatable signed-SAML smoke.
