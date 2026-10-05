# Testing

Four suites, each answering a different question.

| Suite | Command | Answers |
| --- | --- | --- |
| Unit | `pnpm test` | Does this function behave? |
| Integration | `pnpm test` | Do these pieces agree? |
| Live PostgreSQL | see below | Does the database enforce what we claim? |
| End to end | see below | Does it work in a browser? |

## Unit and integration

```bash
pnpm test
```

Vitest. Roughly 245 API and 53 web tests. Fast, no external services.

Test behaviour, not implementation:

```ts
// Survives a refactor.
it('refuses a login that matches no role mapping', () => { /* ... */ });

// Breaks when the function is renamed, and proves nothing.
it('calls matchRoleFromClaims once', () => { /* ... */ });
```

## Live PostgreSQL

```bash
TEST_DATABASE_URL='postgres://oci:oci_dev_password@localhost:5439/oci' \
  pnpm --filter @oci/api exec vitest run src/__tests__/live
```

These use a real database because what they check is enforced *by* the database:
a foreign key that refuses a delete, a unique index, a default that must survive
a migration.

Something a mock cannot tell you. The test that a version of an accepted policy
cannot be deleted is a test of a `restrict` constraint; asserting it in
JavaScript would prove only that the assertion was written.

Each suite creates its own schema and drops it afterwards, so they can run
against a development database without disturbing it.

## End to end

```bash
E2E_BASE_URL=http://localhost:5173 \
E2E_ADMIN_EMAIL=admin@example.com \
E2E_ADMIN_PASSWORD='...' \
  pnpm --filter @oci/web exec playwright test
```

Playwright, in desktop and mobile projects. Includes an accessibility scan
against WCAG 2.2 AA.

The specs sign the same account in from one address many times a minute, in
parallel, which the authentication limit (10 a minute per address and per
account) refuses with `429`. Start the API under test with
`RATE_LIMIT_AUTH_PER_MINUTE=100000` (the browser fixture,
`apps/api/test/browser-performance/server.ts`, sets it itself).

The accessibility check is a **regression net, not a conformance claim**.
Automation covers perhaps a third of the criteria — contrast, names, roles,
structure. Whether an error message actually helps still needs a person.

## GitHub Actions

Pull requests and `main` pushes run read-only validation with Node 22 and pnpm
11.18.0: lint, type checking, builds, unit/integration tests, API coverage floors,
production dependency auditing, license policy, and live/browser tests.
PostgreSQL, Redis, Mailpit and an S3-compatible server provide CI dependencies,
and the PostgreSQL 17 client tools are installed for the backup suite, so every
live suite runs on every pull request and every coverage floor applies there.

### S3 in CI

The storage, backup and compliance-export suites need S3 (and the backup suite
`pg_dump`/`pg_restore`). CI provides:

- **VersityGW** (`versity/versitygw`, Apache-2.0), pinned by tag and digest, as
  a service container: an S3 gateway over a directory (a `tmpfs`, with object
  metadata in a sidecar directory). It is one small static binary configured
  entirely by environment, starts in about a second, and supports what OCI uses:
  multipart uploads, `ListObjectsV2` with prefixes and continuation, `HeadObject`,
  bucket creation and path-style addressing. MinIO no longer publishes community
  images, and building it from source in CI costs minutes per run.
- **`postgresql-client-17`** from the PostgreSQL project's apt repository, its
  signing key checked against the published fingerprint, matching the
  `pgvector/pgvector:pg17` server. The major version is pinned and checked.

With `CI` set, `liveS3Available()` (`apps/api/test/live-backup-tools.ts`)
throws instead of returning false, so an unreachable S3 server fails the
suites rather than skipping them, and the backup suite always requires the
client tools.

The suites read `S3_TEST_ENDPOINT`, `S3_TEST_BUCKET`, `S3_TEST_ACCESS_KEY_ID`
and `S3_TEST_SECRET_ACCESS_KEY` (the older `MINIO_TEST_BUCKET`,
`MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` still work). To run them locally
against the CI server:

```bash
docker run -d --name oci-test-s3 -p 127.0.0.1:7070:7070 \
  -e ROOT_ACCESS_KEY=oci_test -e ROOT_SECRET_KEY=oci_test_password \
  -e VGW_BACKEND=posix -e VGW_BACKEND_ARG=/data -e VGW_META_SIDECAR=/meta \
  --tmpfs /data --tmpfs /meta versity/versitygw:v1.8.0
S3_TEST_ENDPOINT=http://127.0.0.1:7070 TEST_DATABASE_URL=... \
  pnpm --filter @oci/api exec vitest run src/__tests__/live/s3-storage.live.test.ts \
  src/__tests__/live/backups.live.test.ts \
  src/__tests__/live/compliance-export.live.test.ts src/__tests__/live/compliance-holds.live.test.ts \
  src/__tests__/live/compliance-admin.live.test.ts src/__tests__/live/compliance-migration.live.test.ts
```

The MinIO fixture ([Release validation](release-validation.md)) works too;
the suites assert S3 behaviour, not one server's error names.

**Publish containers** reuses validation against the exact checked-out release
tag before publishing to GHCR. It is separate from PR/`main` CI and is the only
workflow that publishes images.
See [Release process](../RELEASING.md) for release gates and manual dispatch.

## What to reach for

**A pure function** — unit test.

**Something the database guarantees** — live test. If it would still pass with
the constraint removed, it is testing the wrong thing.

**Something with a real dependency** — use the real dependency. Two defects in
this codebase survived review and were caught only by exercising the real path:
an audit hook that recorded every *failed* login as a success, because a
failure returns an `APIError` rather than a `Response`; and a report sender that
recorded every send as successful, because `sendEmail` reports failure by
returning a flag rather than throwing. Both compiled. Both looked right.

**Something visual** — end to end, and look at the screenshot. A contrast
calculation is easy to get wrong; sampling the rendered pixels is not.
