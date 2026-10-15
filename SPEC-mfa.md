# Spec: mfa

Module of [SPEC.md](SPEC.md) (v0.14). Depends on nothing. Migrations `0050` and `0051` are reserved for it. Shared
commands, structure, style, testing and boundaries are in SPEC.md. Status: **draft for approval** (research and writing
only; nothing was built, installed or run). Closes #399.

## Objective

Protect local (email and password) accounts, including the break-glass administrator, with a second step, and let
administrators require it per role. Decided: TOTP and recovery codes through Better Auth's `twoFactor` plugin; passkeys
if the official package fits; single sign-on people are exempt; the break-glass administrator is never locked out.

### What the installed code does (Better Auth 1.6.26, read, not run)

- **Tables**: `twoFactor` (`secret`, `backupCodes`, `userId`, `verified`, `failedVerificationCount`, `lockedUntil`) and
  `user.twoFactorEnabled` (`plugins/two-factor/schema.mjs`).
- **Sign-in**: an after-hook on `/sign-in/email` (and username, phone) runs only for a user with `twoFactorEnabled`; it
  deletes the session the password created, sets the signed cookie `two_factor` (10 minutes) and answers
  `{ twoFactorRedirect: true, twoFactorMethods }` (`index.mjs:220-305`). SSO callbacks and passkey sign-in never reach it.
- **Limits**: 5 wrong codes end a challenge; 10 consecutive failures lock the account's second step for 15 minutes
  (`verify-two-factor.mjs:70-85, 109-115`, `totp/index.mjs:185`). The plugin's own limiter (3 per 10 s) never runs: OCI
  turns Better Auth's limiter off (`apps/api/src/auth/index.ts:312`) and OCI's table (`middleware/auth-rate-limit.ts:37`)
  lists no second-step path. The signed-in `verify-totp` path counts nothing at all.
- **TOTP**: SHA-1, 6 digits, 30 s, window 1 (about 90 s), no memory of used codes (`@better-auth/utils` `otp.mjs`): a code
  can be replayed inside the window.
- **Enable** (password) writes `verified=false` and returns the `otpauth://` URI and 10 recovery codes; `twoFactorEnabled`
  turns true when `verify-totp` accepts a code. Called again while enabled it replaces the secret **and keeps
  `verified=true`**, so the new secret is live unconfirmed. **Disable** takes the password only.
- **Recovery codes**: `xxxxx-xxxxx`, mixed-case alphanumeric, an encrypted JSON array, one removed by compare-and-swap
  on the stored ciphertext (`backup-codes/index.mjs:216`): two parallel uses give one success and a 409.
- **Trust this device**: `trustDevice: true` sets a 30-day cookie backed by a `verification` row and skips the second step later.
- **Outside the plugin**: `GET /verify-email` auto-signs in an unverified address (`api/routes/email-verification.mjs:295`);
  `POST /reset-password` creates a `credential` account for a person who had none (`api/routes/password.mjs:161`).

### Passkeys: the official package fits

The installed `better-auth` has no passkey plugin (`dist/plugins/` has none; `apps/api/node_modules/@better-auth/` holds
only `sso`). **`@better-auth/passkey`**, from the npm registry (queried, not installed):

- `1.6.26` exists (published 2026-08-04), **MIT** (`release-1.6` is `1.6.33`, `latest` `1.7.8`).
- Peers: `better-auth ^1.6.26`, `@better-auth/core ^1.6.26`, `@better-auth/utils 0.4.2`, `@better-fetch/fetch 1.3.1`,
  `better-call 1.3.7`, `nanostores ^1.0.1`. The store already holds exactly `utils@0.4.2`, `fetch@1.3.1`,
  `better-call@1.3.7`, `nanostores@1.4.2`, `zod@4.4.3`: no conflict. `@better-auth/sso` is pinned the same way
  (`apps/api/package.json:28`).
- Dependencies: `@simplewebauthn/server ^13.2.3`, `@simplewebauthn/browser ^13.2.2` (MIT), `zod`. The server library adds
  `@peculiar/x509` and `asn1-*`, `@hexagon/base64`, `@levischuck/tiny-cbor` (MIT) and, below them, `asn1js`
  (BSD-3-Clause), `tsyringe`, `pvtsutils`, `pvutils` (MIT), `reflect-metadata` (Apache-2.0), `tslib` (0BSD). All are in
  the allowlist of `scripts/check-licenses.mjs`. I read each package's `latest` licence, not the lockfile's resolved
  version; `pnpm licenses:check` and `pnpm audit --prod` decide, and I could not run them.

**Verdict: passkeys ship**, pinned `1.6.26` in `apps/api` and `apps/web`, gated by those two commands on the branch.
Facts from the tarball that shape the design: registration needs a **fresh** session (`freshAge` 24 h,
`create-context.mjs:148`, not overridden by OCI); authentication hard-codes `userVerification: 'preferred'` and verifies
with `requireUserVerification: false`, then creates a session at once; `registration` and `authentication`
`afterVerification` hooks exist; `origin` and `rpID` default to the request's Origin header and the base URL's host.

## Acceptance criteria

### 1. Data model (0050, 0051)

- **`0050_two_factor`**: table `two_factor` (`id text pk`, `user_id` not null, references `"user"(id)` on delete cascade,
  `secret text not null`, `backup_codes text not null`, `verified boolean not null default true`,
  `failed_verification_count integer not null default 0`, `locked_until timestamptz`, `created_at timestamptz default now()`);
  a **unique** index on `user_id` (the plugin deletes then inserts, so a race fails instead of leaving two rows; the
  generated index on `secret`, which nothing queries, is not made); `ALTER TABLE "user" ADD COLUMN
  "two_factor_enabled" boolean DEFAULT false NOT NULL` (constant default, no rewrite).
- **`0051_session_auth_method`**: `ALTER TABLE "session" ADD COLUMN "auth_method" text` (nullable) and, with passkeys,
  table `passkey` (`id`, `name`, `public_key not null`, `user_id` as above, `credential_id not null`, `counter bigint
  not null`, `device_type not null`, `backed_up boolean not null`, `transports`, `created_at`, `aaguid`) with a unique
  index on `credential_id` and one on `user_id`. **Without passkeys 0051 holds only the session column**, so the journal
  stays sequential for `0052` (`docs/dev/database.md`, "Writing one by hand").
- **Why `auth_method`.** Better Auth records no sign-in method, and the requirement (section 4) must tell a
  password-only session from one that passed a second step, a passkey or SSO. `session.create.before`
  (`auth/index.ts:130`, which already stamps the expiry) receives the endpoint context (`db/with-hooks.mjs`), so it sets
  `authMethod` from `context.path`: `/sign-in/email`, `/sign-up/email` -> `password`; `/two-factor/verify-totp` ->
  `totp`; `/two-factor/verify-backup-code` -> `recovery_code`; `/passkey/verify-authentication` -> `passkey`;
  `/sso/callback*` -> `sso`; else (email-link sign-in, `/two-factor/disable`) -> `other`. NULL (older sessions, v0.13
  replicas) reads as `password`. Declared as `session.additionalFields.authMethod` (`required: false, input: false`).
- **Drizzle mapping** (`packages/db/src/schema/auth.ts`): add `twoFactor`, `passkey`, `user.twoFactorEnabled`,
  `session.authMethod`; add both tables to the adapter `schema` map (`auth/index.ts:95`) under Better Auth's field names
  (`credentialID`, `failedVerificationCount`, `lockedUntil`) mapped to snake_case columns. `pnpm db:generate`, read the
  SQL, `pnpm lint:migrations`: expected clean (new tables, a nullable column, a constant default); not run.
- **Rolling upgrade.** A v0.13 replica names its columns, so it ignores the new tables and columns; its sign-ups get
  `false`, its sessions NULL. It **enforces nothing**: with no plugin, a person enrolled on a v0.14 replica signs in with
  the password alone on a v0.13 replica (during the roll or after a rollback) and the requirement is not applied there.
  So enrolment and the requirement answer `409 MFA_NOT_AVAILABLE_YET` until the roll ends, using the technique of
  `previousReleaseGone()` (`services/embeddings/generations.ts:72`) on any finished 0.14.0 post-deploy step if a sibling
  module adds one (this module adds none for this); otherwise the upgrade note says not to enrol until the roll is done.
  Re-upgrading after a rollback keeps enrolments.
- **Secrets: the TOTP secret is not under `ENCRYPTION_KEY`, deliberately.** The plugin encrypts it with `symmetricEncrypt`
  and `ctx.context.secretConfig`, which is the `AUTH_SECRET` string because OCI passes `secret`, not `secrets`
  (`create-context.mjs:72-80`; XChaCha20-Poly1305 keyed by SHA-256 of the secret). No option replaces this for the TOTP
  secret (recovery codes alone take a custom `storeBackupCodes`). Wrapping the column in OCI's envelope with a Drizzle
  custom type breaks the compare-and-swap above (a random IV never equals the stored value). So both columns stay under
  `AUTH_SECRET`, and **`ENCRYPTED_LOCATIONS` (`packages/db/src/background/reencrypt-secrets.ts:123`) must not list them**:
  the rotation would try `ENCRYPTION_KEY` on `AUTH_SECRET` ciphertext and fail the batch (`docs/dev/database.md`,
  "Encrypted secrets"). A unit test asserts the absence, with the reason in a comment. Consequences, documented: changing
  `AUTH_SECRET` (today it only signs people out) makes every authenticator unreadable; a database backup carries
  secrets only `AUTH_SECRET` opens (`docs/OPERATIONS.md:473`, `backups.md:259`, `external-database-backup.md:416`); the
  reset script (section 4) decrypts nothing. Rotation through Better Auth's `secrets` array is later work (Question 2).

### 2. Sign-in with the second step

- **Plugin setup** (`auth/index.ts:340`): `twoFactor({ issuer: <instance name>, accountLockout: defaults })`, no `sendOTP`
  (no email or SMS codes). The plugin's HTTP `enable`, `disable`, `get-totp-uri`, `generate-backup-codes`, `send-otp`
  and `verify-otp` answer `404` through `api.all`, as `/auth/admin/*` does (`routes/index.ts`, `managedInPeople`); OCI's
  `/api/me/mfa/*` routes call `auth.api.*` server-side and add audit, limits and rules.
- **Web**: `authClient` gains `twoFactorClient` and `passkeyClient` (`apps/web/src/lib/auth-client.ts`).
  `LoginPage.handleSubmit` (`routes/auth/login.tsx:97`) checks `result.data?.twoFactorRedirect` before its success path
  (which clears the query cache and navigates) and goes to a new public route `/auth/two-factor` (registered in
  `router.tsx` like `loginRoute`, redirecting away when signed in) with `returnTo`. One "Authentication code" field
  (spaces and a pasted `123 456` accepted), a "Use a recovery code instead" toggle, a Verify button (no auto-submit),
  "Start again" when the challenge expires. The login page also gets "Sign in with a passkey".
- **Session before verification: none.** The plugin deletes the password's session (`index.mjs:263-265`), so `/api/me`
  answers as anonymous and nothing needs gating. The audit after-hook must not log `auth.signin.local.success` for the
  password step: a 200 `/sign-in/email` with `ctx.context.newSession === null` (the plugin's documented pending state) is
  recorded as `auth.signin.local.challenged`.
- **Limits**: a new `AuthRequestKind` `second-factor` (`services/limits/rate-limit.ts:192`) for `verify-totp`,
  `verify-backup-code`, `/passkey/verify-authentication` and the OCI MFA routes: failures per address and per challenge
  (hash of the `two_factor` cookie, or the session cookie when signed in, as `sessionKey` does, `auth-rate-limit.ts:115`),
  success refunded, `429` with `Retry-After`, `auth.rate_limited` audited once per window.
- **Replay**: a before-hook on `verify-totp` refuses a code accepted for that person within 120 s (hash of person and
  code in the Redis store the rate limiter uses, with its in-process fallback) and records one the plugin accepts.
- **Trust this device: no.** The hook forces `trustDevice` false; no checkbox. Shared campus machines are a core
  population; the default session lasts 30 days (`settings.ts:96`), the cookie's lifetime, so it saves one prompt a month;
  the cookie cannot be listed or revoked and its row survives a reset, so a re-enrolment would be skipped on that
  browser; and the skip keeps a password-method session the requirement could not classify.
- **Recovery codes**: 10 at enrolment, shown once, one use each, regenerated on demand (invalidates all; password and a
  code). Stored codes are never shown: `GET /api/me/mfa` returns only how many remain (server-side `viewBackupCodes` for the
  caller's own id). Codes are case-sensitive: the field trims whitespace and adds the hyphen to 10 pasted characters,
  nothing else. Use is audited (count left) and emailed when SMTP is set (never blocking).
- **Passkeys**: `passkey({ origin: <APP_URL origin>, rpID: <APP_URL host>, authenticatorSelection: { residentKey: 'required',
  userVerification: 'required' }, ... })`. Authentication `afterVerification` refuses unless user verification happened
  (`authenticationInfo.userVerified`; read at the call site, to confirm in the library's types), so a PIN-less security key
  cannot count as two factors, and applies the password's local rules (`localAuthEnabled` or verified administrator,
  `emailVerificationRequired`), refactored out of `enforceAuthRequestPolicy` (`auth/policy.ts:72`) so both share one
  function; the admin plugin already refuses banned people at session creation (`plugins/admin/admin.mjs:36`). A passkey
  sign-in is a full sign-in (`authMethod='passkey'`). **Docs warn that passkeys are bound to the host of `APP_URL`.**
  **If passkeys do not ship**: no table, client plugin or button; the rest is unchanged.
- **Read-only maintenance** (`middleware/read-only.ts:56`, beside `/api/auth/sign-in/*`): `POST /api/auth/two-factor/verify-totp`,
  `/verify-backup-code` and `/api/auth/passkey/verify-authentication` join its allowlist, or no enrolled person could sign
  in during maintenance (`read-only-allowlist.unit.test.ts` enumerates Better Auth's endpoints and fails until decided).

### 3. Enrolment and management (Settings -> Account)

A "Two-step verification" `Row` in the "Security & Access" section of `routes/settings/account.tsx` (route `/settings`),
a component under `routes/settings/account/`.

- **Status**: Off; On (authenticator, N recovery codes left, M passkeys); "Required by your administrator" with the date.
  An account with no `credential` row (SSO only) sees "Managed by your organisation" and the API refuses enrolment (409):
  the plugin only challenges password sign-in, so a TOTP there protects nothing and a passkey adds a local way around
  the identity provider.
- **Enable TOTP**: password -> `POST /api/me/mfa/totp` (409 if already on: replacing an authenticator is disable then
  enable, because the plugin would activate a replacement unconfirmed) -> QR, the manual key (grouped, selectable, Copy)
  and the `otpauth://` link for phones -> a code field -> `verify-totp` -> recovery codes held in component state only
  (never a URL, storage or query cache) with Copy, Download, Print and Done. Responses carry `Cache-Control: no-store`.
- **QR**: no QR library is installed. Recommend one dependency-free MIT library rendered client-side as SVG
  (`qrcode-generator` 2.0.4 or `uqr` 0.1.3 per the registry; source not read), which needs approval (Question 3); fallback is
  the manual key and link. The manual key is the accessible alternative and the SVG is `aria-hidden`.
- **Regenerate codes**: password and a current code. **Disable**: password **and** a current code (or recovery code) through
  `POST /api/me/mfa/totp/disable`, which verifies with `auth.api.verifyTOTP`, counted by the `second-factor` limit and the
  account lockout (no unlimited code oracle at a stolen session), then calls `auth.api.disableTwoFactor` and forwards its
  `Set-Cookie` (it swaps the session). Audited and emailed.
- **Passkeys**: list through OCI (`id, name, createdAt, deviceType, backedUp`, label from the package's
  `getAuthenticatorName`; never `publicKey` or `counter`); Add (a stale session gets "enter your password and sign in again");
  Rename and Remove through the plugin's `update-passkey` and `delete-passkey` (ownership via `requireResourceOwnership`).
- **WCAG 2.2 SC 3.3.8**: the code field has `autocomplete="one-time-code"`, `inputmode="numeric"`, no `maxlength`, no
  paste or drop handler; the password field keeps `current-password`; no CAPTCHA, positional digits or timed re-entry;
  the passkey is the no-transcription alternative; errors are associated with the field and announced, focus goes to the
  first invalid field (as `login.tsx` does).
- **`/auth/mfa-setup`**, outside the app shell: the same component, one paragraph, Sign out.

### 4. Requiring MFA per role

- **Setting**: in the `auth` instance setting (JSON, no migration). `AuthSettings` (`services/settings.ts:65`) gains
  `mfaRequirement?: { roles: UserRole[]; graceDays: number; since: Partial<Record<UserRole, string>> }`, defaulted in
  `normalizeAuthSettings` (`:96`; absent means nobody). The server stamps `since[role]` when a role is added.
  `updateSetting` merges (`:425`), so a v0.13 replica saving the page keeps the keys. Audited by `settings.auth.update`
  (`routes/admin/settings.ts:507`); the shared schema and the Authentication page (`routes/admin/settings.tsx`) gain four role
  checkboxes and a grace field.
- **Who is limited**: role in `roles` **and** session not satisfied **and** can sign in locally **and** deadline passed.
  *Satisfied*: `auth_method` is `sso` or `passkey`, or `totp` / `recovery_code` with `two_factor_enabled` still true.
  *Can sign in locally*, which is **how SSO accounts are recognised**: an `account` row with `provider_id = 'credential'`,
  read as `signInMethodsFor` does (`auth/policy.ts:152`); a person with only SSO accounts is never limited, and an `sso`
  session never is, so a person with both is held to the second step only on password sign-in. A password reset gives an
  SSO-only person a credential account, from which they are subject. *Deadline*: `max(since[role], user.created_at) + graceDays`.
- **Enforcement, server side, every request**: `middleware/mfa-gate.ts`, mounted in `routes/index.ts` after
  `policyAcceptanceGuard` (`:37`) and modelled on it and on `readOnlyGuard`, but for **all methods** (a password-only
  session must not read conversations either) with a deny-by-default allowlist. It uses what `getSession` returns (`role`,
  `twoFactorEnabled`, `authMethod`; the session cache is off, `auth/index.ts:300`) and the cached `auth` setting; the
  credential query runs only for someone otherwise limited. Allowed while limited: `GET /api/health/*`,
  `/api/maintenance`, `/api/branding`, all of `/api/auth/*` (sign-out, second step, passkeys), `GET /api/me`,
  `/api/me/mfa/*`, `DELETE /api/me/sessions/:id`, `POST /api/me/sessions/revoke-others`. Everything else, `/api/admin/*`
  included, is `403 MFA_ENROLMENT_REQUIRED` (new `ERROR_CODES` entry; `lib/api-client.ts` handles it as it does
  `POLICY_ACCEPTANCE_REQUIRED`). An unreadable setting is the retryable error the other middleware gives, not a bypass.
  A test enumerates every registered route, reads included (`test/registered-writes.ts` lists writes only and gains a
  reads counterpart), like `policy-acceptance-allowlist.unit.test.ts`.
- **Web**: `GET /api/me` gains `mfa: { enrolled, methods, recoveryCodesLeft, required, deadline, limited }`. An `MfaGate`
  beside `OnboardingGate` (`router.tsx`, `authenticatedRoute`) and the settings route's `beforeLoad` send a limited person
  to `/auth/mfa-setup`; before the deadline a shell banner says "Set up two-step verification by <date>".
- **Existing sessions when it is turned on**: none is signed out. The gate reads the live setting, so a password-only session
  in the role is limited at its next request once grace has passed (at once with 0); enrolling replaces it with a `totp`
  one. Satisfied, SSO and exempt sessions carry on.
- **Lockout safeguards (break-glass administrator)**:
  1. A limited person always reaches enrolment and sign-out: turning the requirement on never removes the way in.
  2. Saving any requirement is refused (`409 MFA_REQUIRED_FOR_ACTOR`) unless the acting administrator is satisfied, and one
     naming `admin` is refused unless an **enrolled, unbanned local administrator** exists, so nobody can enable what they
     cannot complete. The page states how many people in each role would be limited, and when.
  3. **Operator CLI** `apps/api/src/scripts/reset-mfa.ts` (pattern of `promote-admin.ts`, script `admin:reset-mfa`,
     `node dist/scripts/reset-mfa.js <email>`): deletes the person's `two_factor` and `passkey` rows, sets
     `two_factor_enabled=false`, deletes their sessions, audits `user.mfa_reset_cli` via `recordAudit`, prints no secret,
     decrypts nothing (so it works with any `AUTH_SECRET`). `--unlock` only clears the failure count and `locked_until` (a
     password holder can otherwise keep the second step locked 15 minutes at a time); `--all --yes` is for a changed
     `AUTH_SECRET`. Documented in `docs/OPERATIONS.md` "Getting back in when sign-on fails" (`:2073`).
  4. Administrators reset anyone's MFA from **People -> Users -> the person**: `POST /api/admin/users/:id/mfa/reset`
     (`requireAdmin`: an auditor gets 403), a service beside `revokeUserSessions` (`services/admin-users/mutations.ts:233`)
     that also ends the target's sessions; audited `user.mfa.reset` (actor, target); the target is emailed; not on
     oneself. Auditors see the status read-only. TOTP depends on the server clock: the docs ask for NTP.

### 5. Audit, metrics, documentation, security

- **Audit** (`recordAudit`; never a code, secret, URI or recovery code in metadata): `auth.signin.local.challenged`,
  `auth.mfa.verify.success|failure` (method, reason), `auth.mfa.enabled`, `.disabled`, `.recovery_codes.regenerated`,
  `.recovery_code.used`, `auth.passkey.added|renamed|removed`, `auth.passkey.signin.success|failure`, `user.mfa.reset`,
  `user.mfa_reset_cli`, `settings.auth.update` with the roles. Plugin-owned paths join `AUDITED_PATHS` (`auth/audit.ts`).
- **Metrics** (proposed, in the style of `oci_backup_*`, `services/observability/collected.ts`):
  `oci_mfa_verifications_total{method,outcome}`, `oci_mfa_people{role,state}`, `oci_mfa_limited_people{role}`; an alert
  example in `docs/admin/observability.md`.
- **Docs**: `docs/admin/identity.md` (new "Two-step verification" after "Local accounts": scope, the requirement, the SSO
  exemption and that the identity provider must enforce its own, recovery, `AUTH_SECRET`, `APP_URL`), `people.md`,
  new `docs/user/two-step-verification.md` plus `settings.md`, `getting-started.md`, `README.md`, `docs/OPERATIONS.md` (CLI,
  `AUTH_SECRET`, clock, backups), `docs/dev/database.md` (layout rows; `two_factor` absent from "Encrypted secrets" on
  purpose), `backups.md`, `external-database-backup.md`, `THIRD_PARTY_NOTICES.md`, `CHANGELOG.md` (Added; **Upgrade note**:
  enrol after the roll, `AUTH_SECRET`, `APP_URL`), `ROADMAP.md`. I found no separate docs site in the repository.
- **Security**: secrets never logged (extend `lib/log-redaction.ts` and `log-redaction.integration.test.ts` to the URI,
  codes and fields `code`, `secret`, `backupCodes`, `totpURI`); brute force: challenge, account and `second-factor` limits;
  enumeration: the second step appears only after the right password, a wrong one is answered as today, and an unknown and
  an expired challenge give one error; TOTP is phishable in real time (passkeys are not; say so); the plugin compares
  recovery codes with `includes`, not constant time, bounded only by the limits.

## Files touched (expected)

`packages/db/drizzle/0050_*.sql`, `0051_*.sql` (+ meta), `src/schema/auth.ts`; `apps/api/package.json` + lockfile;
`apps/api/src/auth/{index,audit,policy}.ts`, new `auth/mfa.ts`; `middleware/{mfa-gate,auth-rate-limit,read-only}.ts`;
`services/limits/rate-limit.ts`, `services/settings.ts`; `routes/{index,me}.ts`, new `routes/me-mfa.ts`; admin users route and
`services/admin-users/mfa.ts`; `packages/shared`; `scripts/reset-mfa.ts`; observability; `lib/log-redaction.ts`. Web:
`lib/{auth-client,api-client}.ts`, `routes/auth/{login,two-factor,mfa-setup}.tsx`, `routes/settings/account(.tsx|/two-step.tsx)`,
`router.tsx`, `routes/admin/settings.tsx`, the user page. Tests, `apps/api/vitest.config.ts`, `apps/api/test/{totp,registered-writes}.ts`, docs.

## Commands (module-specific)

```sh
pnpm db:generate && pnpm lint:migrations
python3 $H/run.py test mfa src/__tests__/unit/mfa-*.unit.test.ts src/__tests__/live/mfa-*.live.test.ts
python3 $H/run.py test mfa-regression src/__tests__/unit/{read-only,policy-acceptance}-allowlist.unit.test.ts \
  src/__tests__/live/{auth-rate-limit,session-revocation,account-settings,sso-authorisation,encryption-rotation}.live.test.ts
python3 $H/run.py web tests/unit        # then e2e as CI's seeded step, spec mfa
node tools/upgrade-test/run.mjs --from v0.13.1 && pnpm licenses:check && pnpm audit --prod
```

## Testing strategy

Red first: each test fails on v0.13 (no plugin, so `/api/auth/two-factor/*` is 404; a required role has no gate).

- **TOTP in tests, no dependency**: `apps/api/test/totp.ts` implements RFC 6238 with `node:crypto` (HMAC-SHA1, base32
  decode of the URI's `secret`), checked against RFC 6238 Appendix B vectors (T=59 gives 94287082 at 8 digits, from memory;
  verify against the RFC); a copy in `apps/web/tests/e2e/totp.ts` (Playwright runs in Node). `@better-auth/utils` is not a
  direct dependency, and the library under test is not its own oracle.
- **Unit**: the gate's decision table (role, method, credential account, grace, deadline, SSO session, NULL method) and
  enumerated allowlist; method-from-path; replay guard; settings safeguards; `ENCRYPTED_LOCATIONS` lacks `two_factor`;
  challenged-audit detection; `second-factor` limits.
- **Live (real PostgreSQL, real Better Auth)**, as `account-settings.live.test.ts`: enrol, sign in, second step; challenge dies
  at 5, account locks at 10, `--unlock` clears; replay refused; `trustDevice` ignored; a recovery code works once and two
  parallel uses give one success; regenerate invalidates; disable needs both factors; an SSO-only account is exempt and
  cannot enrol, a dual account is held on password sign-in only; requirement on: an existing password session is limited
  (`/api/threads` 403; `/api/health/live`, sign-out, `/api/me/mfa` 200) and enrolling lifts it; grace; `admin` cannot be
  required with no enrolled admin; **the seeded administrator still signs in, enrols and reaches `/api/admin` when `admin`
  is required and nobody is enrolled**; reset by administrator and by CLI function (sessions gone, audit row, auditor 403);
  read-only mode admits the second step; v0.13-shaped rows and queries (no new columns) still work.
- **Upgrade**: `tools/upgrade-test` from v0.13.1 with 0050 and 0051 under load.
- **Browser (Playwright)**: `mfa.spec.ts` on a disposable account as `settings-account.spec.ts` does (never the seeded
  administrator, or every other spec breaks): enrol through the UI from the page's manual key, sign out, sign in with a
  computed code and with a recovery code, disable; axe with the WCAG 2.2 tags at each step plus explicit 3.3.8 checks
  (`autocomplete`, `inputmode`, no `maxlength`, a pasted `123 456` accepted). The requirement test applies it to
  `restricted` only, in a serial describe that restores the setting in `afterAll`, because `fullyParallel`
  (`playwright.config.ts`) specs sign in as `user` and `admin`. `mfa-passkey.spec.ts` uses CDP `WebAuthn.enable` and
  `addVirtualAuthenticator` (`ctap2`, `internal`, resident key, user verification, automatic presence); both the `chromium`
  and `mobile-chromium` projects are Chromium, so nothing is skipped. `APP_URL` must equal the browser origin for `rpID` and
  `origin` to match; I did not check how CI sets it.
- **Floors** (`vitest.config.ts`, beside `read-only.ts` 98/90/100): `middleware/mfa-gate.ts` 98/90/100, `auth/mfa.ts` 95/85/100,
  the new services and routes from the first green run; `auth/policy.ts` (85/85/100) holds after the refactor. Web unit tests
  for the two-factor page and enrolment dialog. Manual: `dev-env` with a real authenticator and QR scan, then taken down.

## Boundaries (module-specific)

- **Always:** keep `localAuthEnabled` and the verified-administrator path working; the gate deny-by-default and enumerated
  by a test; secrets, codes and URIs out of logs, audit, metrics and docs; the CLI working without `AUTH_SECRET`; every MFA
  change audited.
- **Ask first:** the QR library; listing `two_factor` in `ENCRYPTED_LOCATIONS` or enveloping the plugin's secret; `secrets`
  rotation; per-provider SSO exemption flags; email or SMS codes; "trust this device"; changing session creation beyond the
  two columns.
- **Never:** expose the plugin's `enable`, `disable`, `get-totp-uri` or `generate-backup-codes` over HTTP; show stored codes
  or the secret after enrolment; exempt a role from the gate or add an environment bypass; apply the requirement while a
  v0.13 replica can serve; enrol the seeded administrator in tests.

## Success criteria

Acceptance criteria hold; `checks`, `pnpm lint:migrations`, `licenses:check`, `pnpm audit --prod`, `pnpm release:check` pass;
the upgrade test passes from v0.13.1; coverage passes with zero skips; the MFA browser suites pass including the virtual
authenticator; the `dev-env` check is done and the environment taken down; docs, CHANGELOG and ROADMAP updated; #399 closed.

## Decisions (were open questions; every recommendation accepted 2026-10-14, including the new web dependency `qrcode-generator` and the API dependency `@better-auth/passkey` 1.6.26)

1. **Trust this device?** *No* (section 2); revisit with a listable, revocable record.
2. **`AUTH_SECRET` coupling:** keep the plugin's encryption and document it, or adopt `secrets` rotation now? *Keep and
   document*; rotation later with its own migration test.
3. **QR library:** *allow `qrcode-generator`* (web only, dependency-free, MIT); otherwise manual key and link only.
4. **Default grace:** *14 days*, 0 selectable, with a warning that 0 limits people at their next request.
5. **Email on MFA changes:** *yes* when SMTP is set, never blocking.
6. **Gate enrolment until the roll ends:** *the note, plus the post-step technique only if a sibling module adds a 0.14.0
   step*; no step added for this.
7. **A passkey satisfies the requirement only with user verification** (enforced in `afterVerification`): *yes*; treat
   PIN-less keys as unsupported.

## Not verified

Nothing was built, installed or run: not `lint:migrations`, `licenses:check`, `audit`, the generated SQL or any test. The
plugin flows above were read, not executed. Unconfirmed: that `auth.api.*` calls from OCI routes run Better Auth's hooks and
return the swapped session's `Set-Cookie` (first spike test); that `context.path` is set for sessions created inside such
calls; `authenticationInfo.userVerified` in `@simplewebauthn/server` 13; the RFC vectors (from memory); transitive licences at
`latest`, not the lockfile's versions; the Redis primitives for the replay guard; that `collected.ts` suits per-role gauges; how
CI sets `APP_URL` for the seeded browser step; the QR libraries' source; the CDP options (standard, not run). No docs site
directory exists in the repository, so "docs-site notes" are the `docs/` files above; a site elsewhere needs the same pages.
