# Two-step verification: API contract (v0.14, #399)

What the web app (and any other client) calls. The shapes are Zod schemas in `packages/shared/src/schemas/mfa.ts`
(`@oci/shared`); the error codes `MFA_ENROLMENT_REQUIRED` and `MFA_REQUIRED_FOR_ACTOR` are in `ERROR_CODES`. Spec:
`SPEC-mfa.md`. Everything below is under `/api`; every response from `/api/me/mfa/*` carries `Cache-Control: no-store`.
Errors use the usual `{ error: { code, message, details? } }` body, except the Better Auth paths, which answer
`{ code, message }` (and `error` for the rate limit), as the sign-in page already reads them.

## Who can use it

Only an account with a password (a `credential` row) can enrol. A person who signs in only through the organisation
gets `eligible: false` and `409 CONFLICT` on every enrolment endpoint; the page says "Managed by your organisation".
Single sign-on sessions, and passkey sessions, are never held to the requirement.

## 1. Signing in with a second step (Better Auth endpoints, `authClient`)

The web app adds `twoFactorClient()` and `passkeyClient()` (from `@better-auth/passkey/client`, pinned `1.6.26`) to
`authClient` (`apps/web/src/lib/auth-client.ts`).

| Step | Call | Result |
|---|---|---|
| Password | `authClient.signIn.email({ email, password })` (`POST /api/auth/sign-in/email`) | For a person with a second step: **200 `{ twoFactorRedirect: true, twoFactorMethods: ['totp'] }`**, no session, a signed `two_factor` cookie valid 10 minutes. Go to `/auth/two-factor?returnTo=...`. Otherwise as before. A wrong password is answered as today (401 `INVALID_EMAIL_OR_PASSWORD`), so the second step never appears without the right password. |
| Authenticator code | `authClient.twoFactor.verifyTotp({ code })` (`POST /api/auth/two-factor/verify-totp`) | 200 and a session cookie (`auth_method = totp`). Spaces in the code are ignored. Do not send `trustDevice`: the server ignores it (no "trust this device"). |
| Recovery code | `authClient.twoFactor.verifyBackupCode({ code })` (`POST /api/auth/two-factor/verify-backup-code`) | 200 and a session (`auth_method = recovery_code`); the code is used up. Case matters; surrounding spaces are trimmed and a missing hyphen in 10 pasted characters is added. |
| Passkey | `authClient.signIn.passkey()` (`GET /api/auth/passkey/generate-authenticate-options`, `POST /api/auth/passkey/verify-authentication`) | 200 and a session (`auth_method = passkey`), no password and no second step: a passkey is both. Refused unless the authenticator verified the user (PIN or biometric). |

Errors on these paths (`code`, with the HTTP status): `INVALID_CODE` 401 and `INVALID_BACKUP_CODE` 401 (wrong code);
`INVALID_TWO_FACTOR_COOKIE` 401 (an unknown and an expired challenge give this one error: "Start again");
`TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE` 400 (5 wrong codes end a challenge: "Start again");
`ACCOUNT_TEMPORARILY_LOCKED` 429 (10 consecutive failures lock the second step for 15 minutes; an administrator or the
`admin:reset-mfa --unlock` CLI clears it); `TOO_MANY_REQUESTS` 429 with `Retry-After` (OCI's `second-factor` limit);
`CODE_ALREADY_USED` 401 (an authenticator code, or a recovery code, already accepted or in flight in the last 120 seconds is refused: wait for the next authenticator code; the same applies right after enrolling, when the confirming code was this window's);
`LOCAL_AUTH_DISABLED` 403 and `EMAIL_NOT_VERIFIED` 403 on a passkey sign-in, as on the password; `BANNED_USER` 403.

These POSTs stay open in read-only maintenance mode (`/api/auth/two-factor/*`, `/api/auth/passkey/verify-authentication`).

## 2. Status: `GET /api/me` and `GET /api/me/mfa`

`GET /api/me` gains **`mfa: MfaSummary`**:

```ts
{ eligible: boolean; enrolled: boolean; methods: ('totp' | 'passkey')[];
  recoveryCodesLeft: number | null; required: boolean; deadline: string | null; limited: boolean }
```

`GET /api/me/mfa` answers **`MfaStatus`** = `MfaSummary` plus `passkeys: { id, name, createdAt, deviceType, backedUp }[]`
and `lockedUntil: string | null`. It is allowed while the session is limited. `limited` is true when this session is
refused everywhere else (see 5).

## 3. Enrolment and management (OCI routes, `/api/me/mfa/*`)

Plugin endpoints that must never be reachable from the browser (`/api/auth/two-factor/enable`, `/disable`,
`/get-totp-uri`, `/generate-backup-codes`, `/send-otp`, `/verify-otp`, `/api/auth/passkey/list-user-passkeys`) answer
404; use these instead. Each audits and is limited by `second-factor`.

| Call | Body | Response |
|---|---|---|
| `POST /api/me/mfa/totp` | `{ password }` | `200 { totpURI, manualKey }`. **409** when an authenticator is already on (disable it first) or the account has no password. **422** with `details` on the `password` field when it is wrong. Nothing is on yet: the secret is live only for confirming. |
| `POST /api/me/mfa/totp/confirm` | `{ code }` | `200 { recoveryCodes: string[] }` (10 codes, **shown once**: keep them in component state only) and a **`Set-Cookie`**: the session is replaced by a `totp` one. **422** on a wrong code (the secret stays; try again), **409** when nothing is waiting to be confirmed. |
| `POST /api/me/mfa/totp/disable` | `{ password, code }` (`code` is an authenticator or a recovery code) | `200 { ok: true }` and a `Set-Cookie` (the session is swapped). **422** on a wrong password or code; counted by the `second-factor` limit and the account lockout. |
| `POST /api/me/mfa/recovery-codes` | `{ password, code }` | `200 { recoveryCodes }` (new 10, all the old ones stop working). Same errors as disable. |

Passkeys use the plugin's endpoints through `authClient.passkey` (OCI adds rules and audit in hooks); the list is
OCI's:

| Call | Notes |
|---|---|
| `authClient.passkey.addPasskey({ name })` (`GET /api/auth/passkey/generate-register-options`, `POST /api/auth/passkey/verify-registration`) | Needs a **fresh** session (signed in within the last 24 hours): otherwise `403 SESSION_NOT_FRESH`; show "enter your password and sign in again". Refused with `409 { code: 'PASSKEY_NOT_AVAILABLE' }` for an account without a password. Resident key and user verification are required. |
| `authClient.passkey.updatePasskey({ id, name })` (`POST /api/auth/passkey/update-passkey`) | Rename; owner only. |
| `authClient.passkey.deletePasskey({ id })` (`POST /api/auth/passkey/delete-passkey`) | Remove; owner only. |
| list | `GET /api/me/mfa` (`passkeys`), never the plugin's list. |

Passkeys are bound to the host of `APP_URL` (`rpID`) and its origin: a changed `APP_URL` orphans them.

## 4. Administrators

| Call | Notes |
|---|---|
| `GET /api/admin/users/:id` | gains `mfa: AdminMfaStatus` = `{ eligible, totp, passkeys, recoveryCodesLeft, lockedUntil, required, deadline }`; auditors see it read-only. |
| `POST /api/admin/users/:id/mfa/reset` | `requireAdmin` (an auditor gets 403). Removes the person's authenticator, recovery codes and passkeys, ends their sessions, emails them, audits `user.mfa.reset`. `200 { ok: true, sessionsEnded }`. 422 on oneself, 404 unknown. |
| `GET /api/admin/settings` | gains `mfaRequirement: { roles, graceDays, since }` (`since`: ISO stamp per required role). |
| `PATCH /api/admin/settings` | accepts `mfaRequirement: { roles, graceDays }` (strict; `since` is stamped by the server when a role is added). **409 `MFA_REQUIRED_FOR_ACTOR`** (`details.reason`: `actor_not_satisfied` or `no_enrolled_admin`) when a *changed* requirement is saved and the acting administrator is not satisfied (an unchanged one riding along with other settings is not a save, and removing roles is always allowed), or when `admin` is named and no enrolled, unbanned local administrator exists. Audited `settings.auth.update`. |
| `GET /api/admin/settings/mfa-impact` | `MfaImpact`: per role `people, exempt, enrolled, unenrolled, required, since, firstDeadline, limitedNow`, for the saved requirement (unbanned accounts). |

## 5. The requirement and the gate

A person is **limited** when their role is required, the session is not satisfied, they can sign in with a password,
and the deadline (`max(since[role], user.created_at) + graceDays`) has passed. *Satisfied* means `auth_method` is `sso`
or `passkey`, or `totp` / `recovery_code` with the second step still on. A limited session gets
**`403 MFA_ENROLMENT_REQUIRED`** (`details: { reason: 'enrol' | 'second_step', deadline }`) on everything except:
`GET /api/health/*`, `/api/maintenance`, `/api/branding`, all of `/api/auth/*`, `GET /api/me`, `/api/me/mfa/*`,
`DELETE /api/me/sessions/:id`, `POST /api/me/sessions/revoke-others`. `lib/api-client.ts` should treat it as it treats
`POLICY_ACCEPTANCE_REQUIRED`: send the person to `MFA_SETUP_PATH` (`/auth/mfa-setup`). Before the deadline,
`mfa.required && !mfa.limited && !mfa.enrolled` is the shell banner: "Set up two-step verification by <deadline>".

## Spike results

The spec listed what its author could not verify. Each was settled by running it
(`mfa-library-behaviour.unit.test.ts`, `mfa-redis-primitives.integration.test.ts`; the library tests use a standalone
Better Auth instance on the in-memory adapter with the plugin options and hook shapes OCI uses, so a Better Auth
upgrade that changes any of them fails there first):

1. **`auth.api.*` runs Better Auth's hooks and returns the swapped session's cookie: yes.** A server-side
   `auth.api.verifyTOTP({ headers, body, returnHeaders: true })` ran the `before` and `after` hooks with
   `ctx.path === '/two-factor/verify-totp'`, and `returnHeaders` carries the `Set-Cookie` of the new session (a
   different token from the one sent; the old session is gone). Same for `disableTwoFactor`. OCI's routes forward the
   cookies with `headers.getSetCookie()`.
2. **`context.path` for a session created inside such a call: set.** `databaseHooks.session.create.before(session,
   context)` receives the endpoint's path: `/sign-up/email`, `/sign-in/email` (the password step of an enrolled
   person's sign-in: the session is deleted again and no session is left), `/two-factor/verify-totp` (the sign-in's
   second step *and* the swap when enrolment is confirmed), `/two-factor/disable`, `/passkey/verify-authentication`.
   So `auth_method` can be set from the path alone.
3. **`userVerified` in `@simplewebauthn/server` 13: present.** The plugin's `authentication.afterVerification` receives
   `verification.authenticationInfo.userVerified` (a boolean from the UV flag the authenticator signed). A PIN-less key
   gives `false`; throwing an `APIError` there answers 401 before any session exists. Registration options with
   `userVerification: 'required'` do not stop a registration response whose UV flag is clear (the plugin verifies
   with `requireUserVerification: false`), so the check is at sign-in, where it counts.
4. **Redis primitives for the replay guard: `SET key 1 EX 120 NX`** answers `OK` once and `null` after, exactly one
   of 25 concurrent attempts wins, and the key expires on its own (real server).
5. **Transitive licences:** `pnpm licenses:check` ("License policy passed") and `pnpm audit --prod` ("No known
   vulnerabilities found") pass with `@better-auth/passkey@1.6.26` in `apps/api` (lockfile resolves
   `@simplewebauthn/server` 13.3.3 and `@simplewebauthn/browser` 13.3.0). `THIRD_PARTY_NOTICES.md` records only
   material that is not under a permissive licence, so it is unchanged.

Other facts the tests pinned: the signed-in `verify-totp` accepts the same code again and again (the plugin keeps no
memory of used codes: OCI's replay guard is its own); registration needs a session created in the last 24 hours:
`403 SESSION_NOT_FRESH` otherwise.

## Behaviour the web must know (found by running it)

- **Hooks run for every `auth.api` call and the cookie of a swapped session comes back in `Set-Cookie`.** Confirming
  the authenticator and turning it off both replace the session; the browser just keeps the cookies it is given.
- **The enrolment confirmation uses this window's code.** Signing in again within about two minutes needs the
  *next* code (`CODE_ALREADY_USED` otherwise). Browser tests must use the next or previous 30-second step.
- **One use per recovery code holds under concurrency** only because OCI claims the code first. The plugin's own
  guarded update is `WHERE id IN (SELECT ...)` in the Drizzle adapter, which passes twice under READ COMMITTED:
  about one pair in four spent the same code twice before the claim.
- **Option hooks run before the plugin's.** The audit hook sees the password step's session still present, so
  "challenged" is decided from the person's `twoFactorEnabled`, not from `newSession === null`.
- **A passkey session never asks for a second step**, and a person limited by the requirement with only a passkey
  must sign in *with* the passkey (the password session is limited).
- **Test helpers:** `apps/api/test/totp.ts` (RFC 6238, checked against Appendix B), `test/webauthn.ts` (a software
  authenticator; `userVerified: false` makes a PIN-less key), `test/live-client.ts` (cookie jar).
