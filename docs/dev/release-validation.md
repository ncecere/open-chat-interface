# Release validation checkpoint

Recorded 2026-10-01. This is validation evidence, not release approval or a
production deployment. Application source is based on checkpoint `1f2a1a3`, with
the dependency updates and test corrections described below.

Two independent, scoped source reviews found no blocking findings: the initial
onboarding/MinIO/evidence changes, then the dependency/test-deadline additions.
Neither reviewer independently executed the reported gates. Owned test
containers/network and generated credential/runtime directories are removed;
nonsensitive local reports remain. No production data or homelab files changed.

## Results and limits

| Gate | Result |
| --- | --- |
| Fresh shared/database/API/web builds and initial-route chunk check | Passed with an allowlisted environment and Vite env-file loading disabled |
| Real S3-compatible storage and SMTP suites | 12 tests passed, no skips, against isolated MinIO and Mailpit |
| Post-update unfiltered API coverage | 799 tests / 78 files passed on the host and again in Linux; no skips, coverage floors passed |
| Post-update production desktop/mobile Playwright suite | 44 passed; no skips, failures or retries classified as flaky |
| Forced workspace gates | Typechecks, 459 normal API tests, 246 web tests, lint, 13 license expressions and diff checks passed |
| Linux/arm64 images | API runtime/build and web build passed; runtime Node 22.23.3 / built-in Undici 6.28.1; non-root clean-database migration and live/ready smoke passed |
| Manual browser checks | Real password login, all introduction steps, settings navigation, completed streaming, explicit Stop and draft preservation passed |
| Introduction accessibility scan | Zero violations in the selected WCAG 2.2 AA rule tags; not a full conformance claim |
| Dependency advisory audit | Initial 17 findings; targeted updates re-audit with zero known advisories |

Counts overlap and must not be added together. These local Linux images are
arm64; the release workflow's linux/amd64 target remains a separate CI gate.

The live API suites use real PostgreSQL, Redis, SMTP and S3-compatible transport
where their fixtures require them. That does not make mocked model inference,
settings seams or injected failures production-provider/packet-loss evidence.

The browser fixture uses real authentication and API routes, a disposable
PostgreSQL database, local storage and a local deterministic model provider. It
intentionally has no Redis or lifecycle jobs. Existing E2E cases intercept some
catalog, chat and administrative responses; they are not proof of every real
administrative mutation. Manual streaming used the local provider: two requests,
one completed and one cancelled, with zero active streams afterwards. There were
no paid inference calls or production-account changes.

An initial manual wait used the wrong Stop-button label and timed out; this was
an automation-selector error, not an application defect. Repeating with the
actual **Stop generating** control verified cancellation and draft preservation.

## Onboarding coverage correction

Previously the introduction test checked visibility immediately after the login
click, then skipped if the wizard was absent. Both desktop and mobile cases
silently skipped under the baseline; a wrapper rejecting skipped tests failed.

The corrected test waits for visible introduction UI. Its per-page onboarding
fixture fetches the real authenticated response, requires no pending policy,
preserves the other fields, and supplies `needsIntroduction: true` after a
500 ms delay. This tests asynchronous loading independently of another test's
persisted dismissal. It does not forge authentication or alter saved preferences.
Both focused cases pass, followed by all 44 browser cases. Real introduction
completion was also checked separately without that interception.

## Dependency remediation and final rerun

The baseline audit reported four high, nine moderate and four low advisories,
across four packages in production dependency graphs. Targeted updates are:

| Package | Before | After | Scope |
| --- | --- | --- | --- |
| Nodemailer | 9.1.1 | 10.0.9 | API SMTP runtime; intentional major update, Node >=20 supported by the app's Node >=22 baseline |
| Hono | 4.13.5 | 4.13.7 | API router and adapter peer resolution |
| Undici | 7.29.0 | 7.29.1 | Range-limited 7.x override for SDK transport dependency |
| DOMPurify | 3.4.13 | 3.4.16 | Range-limited 3.x override for the Markdown dependency graph |

Nodemailer 10 supplies its own declarations, so the old `@types/nodemailer`
package was removed. Its installed ESM/default-export and SMTP overloads match
the service's use. AI SDK versions, `postgres@3.4.9`, and the existing Postgres
shutdown patch/hash are unchanged. The refreshed lockfile changes only those
four package resolutions, the corresponding Hono peer binding and removed types.

Registry audit now reports zero known advisories. That is not proof of universal
non-exploitability, and it does not audit container OS packages or upgrade Node's
separately bundled Undici. No reachability waiver or ignored advisory was used.
Post-update builds, browser, host/Linux API coverage and workspace gates pass.

During rerun preparation, the initial clean environment was found to carry
`NODE_ENV=test` into Vite. Those initial browser checks are functional evidence,
not a production-bundle gate. Builds/previews were corrected to explicitly use
`NODE_ENV=production`, and all 44 browser cases passed again after the dependency
updates. This does not change the separate, earlier phase-9 performance measurements.

One post-update coverage run exceeded the default five-second timeout in the
501-thread retention case. The unchanged 500/1/0 batch assertions passed in an
isolated diagnostic (2.66 seconds). Only that test now gets 20 seconds for its
501 real per-thread transactions under coverage/CI load; no application logic or
batch assertion was relaxed. Both subsequent full 799-test runs passed.

The private test HOME initially caused pnpm's license command to look in a
missing package-metadata store. Configuring only that private HOME to use the
existing package store restored the unchanged license gate. Turbo's strict
environment also stripped service URLs from the normal test job; final forced
test jobs used `--env-mode=loose` only inside the explicit environment allowlist.
All 459 normal API tests then ran without skips. Do not use that mode with an
uncontrolled production environment.

## Legacy MinIO fixture from pinned source

The existing pinned Docker Hub image could not be pulled; the official Quay
location returned unauthorized with the available access. No registry login,
third-party mirror or production object store was substituted.

Upstream `minio/minio` README at `7aac2a2c5b7c882e68c1ce017d8256be2feea27f`
describes source-only distribution and an unmaintained community repository.
With owner approval, the validation fixture was built from the existing test
version's source:

- Tag: `RELEASE.2025-09-07T16-13-09Z`
- Commit: `07c3a429bfed433e49018cb0f78a52145d4bedeb`
- Uncompressed Git archive SHA-256:
  `3fd74f9e3123e8d112141b9764e583b263c711b9ce87661bfa3afda586f92091`

This is a **test-only source build, not an official release image or a supported
production-storage recommendation**. [The fixture Dockerfile](../../docker/minio-test.Dockerfile)
checks that archive checksum and retains the upstream license. Its compiler and
base-image tags are not digest-pinned; do not claim bit-for-bit reproducibility.

From the OCI repository root, use new, owned temporary directories:

```sh
SOURCE=$(mktemp -d)
CONTEXT=$(mktemp -d)
git clone --depth 1 --filter=blob:none --no-checkout \
  --branch RELEASE.2025-09-07T16-13-09Z \
  https://github.com/minio/minio.git "$SOURCE/repo"
test "$(git -C "$SOURCE/repo" rev-parse HEAD)" = \
  07c3a429bfed433e49018cb0f78a52145d4bedeb
git -C "$SOURCE/repo" archive --format=tar \
  07c3a429bfed433e49018cb0f78a52145d4bedeb > "$CONTEXT/minio-source.tar"
docker build -f docker/minio-test.Dockerfile \
  -t oci-minio-test:07c3a429 "$CONTEXT"
```

Run only an isolated container with a private env file containing generated test
`MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, loopback-only published ports, and writable
storage for UID 10001. Disable its browser and update checks:

```sh
# TEST_ENV names a private fixture-only file; never use production credentials.
CONTAINER_ID=$(docker run -d --env-file "$TEST_ENV" \
  -e MINIO_BROWSER=off -e MINIO_UPDATE=off \
  -p 127.0.0.1::9000 --tmpfs /data:uid=10001,gid=10001,mode=0700 \
  oci-minio-test:07c3a429 server /data --address :9000)
docker port "$CONTAINER_ID" 9000
```

Wait for `/minio/health/ready` on that exact published endpoint. Supply
`S3_TEST_ENDPOINT`, a unique `MINIO_TEST_BUCKET`, and the fixture credentials to
the S3 test process through its environment, never printed command arguments.
`src/__tests__/live/s3-storage.live.test.ts` creates the bucket and cleans its
exact object keys. Reject skipped suites. Stop/remove only the recorded container
ID and remove only the temporary directories/files created for this run.

This recipe does not repair or change the other Compose files' registry references.
Do not assume those optional MinIO services now pull successfully.

## S3 in pull-request CI (v0.10)

Pull-request CI does not build MinIO. It runs VersityGW
(`versity/versitygw:v1.8.0`, Apache-2.0, pinned by digest) as a service, and
installs `postgresql-client-17` from the PostgreSQL apt repository, so the
storage, backup and compliance-export suites run on every pull request with
their coverage floors ([Testing](testing.md#s3-in-ci)). Before switching, the
three S3 suites were run locally against that exact image (posix backend,
sidecar metadata, `CI=true` so nothing could skip): 30 tests passed, none
skipped; the same suites pass against this MinIO fixture. One assertion had
named MinIO's error (`XMinioInvalidResourceName`); it now checks the HTTP 400
that both return. The MinIO source build stays available for release
validation against a second implementation.

## Isolation and remaining gates

Host-side application/test validation used an explicit environment allowlist,
private HOME/TMPDIR and storage, owned loopback endpoints and fresh test secrets.
Container validation used the private Docker network and fixture-only env files.
Neither inherited provider/AWS credentials or proxies. The default application
`DATABASE_URL` was inert for API tests; live helpers received the separate owned
control URL. Browser credentials were passed privately, and Playwright tracing
was disabled.

Resource cleanup is by exact owned process/container/database/session identifiers,
not a prefix scan. The existing database fixture helper can still leak its exact
created database if migration fails before returning the cleanup handle; use a
dedicated disposable PostgreSQL instance rather than a shared server.

PR CI, version/release preparation, live backup and restore readiness, paired
image publication, and the drained deployment and
rollback checks remain open. Historical account-access policy is separate; see
[the evidence assessment](email-verification-provenance.md).
