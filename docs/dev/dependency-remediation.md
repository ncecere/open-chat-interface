# Dependency advisory remediation — September 2026

The September 16 production audit reported **20 advisory entries: 10 high and
10 moderate**. After this dependency-only update, both `pnpm audit --prod` and
`pnpm audit` report **zero advisories**. This is a scanner result at a point in
time, not proof that every dependency or deployed path is vulnerability-free.
No advisories, optional packages or audit categories are ignored.

## Changes

| Package | Before | After |
| --- | --- | --- |
| Hono | 4.13.0 | 4.13.5 |
| Nodemailer | 9.0.1 | 9.1.1 |
| `@xmldom/xmldom` | 0.8.13 | 0.8.15 |
| Transitive Nanoid | 3.3.17 | 3.3.18 |
| Vitest, its mocker and V8 coverage provider | 3.2.6 | 4.1.11 |

Direct dependencies are pinned. Range-limited workspace overrides patch only
vulnerable XML 0.8.x and Nanoid 3.x versions; they do not downgrade newer safe
versions. Parent dependency ranges permit these patched versions. Keep the
overrides until a reviewed dependency refresh guarantees the same lower bounds.

Vitest and its coverage provider move together. Better Auth's optional Vitest
peer accepts v4; the existing Vite 8 version is retained. Old test-runner
transitives disappear from the lockfile. The more precise coverage mapping
exposed gaps in existing tests, so regression assertions were added for auth
settings failures, token helpers, quota-window fallback and public-share
sanitization. **Coverage thresholds were not lowered.** No application behaviour
was changed to make the new runner pass.

## Local verification

Build, lint, typechecks and license policy pass on the dependency branch.
Vitest 4 runs **288 API unit/integration tests and 120 web tests** successfully.
The coverage run passes the unchanged thresholds with **383 tests**, including
95 live PostgreSQL/SMTP tests; six S3 tests skip. These counts describe this
branch based on the refactor baseline, not the separate runtime-fix branch.
The signed-SAML smoke (since removed, #53) also passed using Samlify 2.13.1 and xmldom 0.8.15.

## Reachability and limits

- **XML:** used by the SAML stack, which `@better-auth/sso` still depends on
  (Samlify, xmldom) although OCI no longer offers SAML sign-in or answers its
  routes (#53), so SAML input is not reachable. Serializer attacks depend on the
  DOM operations used.
- **Hono:** query parsing is used. OCI's JSON validation helper is distinct from
  Hono's dot-notation body parser; no static-site generation call was found.
- **Mail:** SMTP delivery uses Nodemailer. No legacy `resolveContent` call was
  found; domain-bypass exploitability depends on surrounding validation.
- **Vitest/Nanoid:** the audit included optional paths through Better Auth's
  test-runner peer. Optional does not mean harmless or deployed: inspect the
  actual production package/image before claiming runtime exposure.

No external IdP, production deployment or provider-inference test is implied by
these checks. Runtime defects from the structural review are tracked in the
separate runtime-safety change.

## Repeat verification

Use the project's Node 22 environment (verified locally on 22.23.0), install the
committed lockfile and build workspace packages before tests:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod
pnpm audit
pnpm licenses:check
```

For live tests and the unchanged coverage thresholds, provide
`TEST_DATABASE_URL` and `TEST_REDIS_URL`; start isolated Mailpit and MinIO test
services as described in [testing](testing.md), then run `pnpm test:coverage`.
Do not confuse unavailable-service skips with successful tests. During local
remediation, Mailpit was available but the configured MinIO image could not be
pulled, leaving six S3 checks unverified.

The repeatable SAML dependency smoke (`scripts/smoke-saml.mjs`) that used to run
here was removed with SAML sign-in itself (#53); nothing in OCI verifies a SAML
response any more.
