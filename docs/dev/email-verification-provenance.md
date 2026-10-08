# Historical email-verification evidence

## Scope and conclusion

Source review compares `fd4cfa0` with remediation checkpoint `6257862`, using
installed Better Auth/SSO 1.6.26. This is not confirmation of which revision ran
in production, which accounts used a particular path, or whether any account is
illegitimate. No production database, credentials, accounts or sessions were
accessed or changed for this review.

**The stored verification flag does not reliably establish mailbox ownership.**
There is no complete, durable, address-bound verification receipt for every
account. Missing audit evidence means *unknown*, not automatically verified or
unverified. Creation/update timestamps cannot resolve that ambiguity.

## What can set the flag

| Path | Evidence and limits |
| --- | --- |
| Historical delivery fallback | At `fd4cfa0`, `apps/api/src/auth/policy.ts` waived enforcement for unusable SMTP or policy-read failure. `auth/index.ts`, `services/admin-users/mutations.ts` and `services/invitations.ts` could mark accounts verified without successful delivery. Source shows possibility, not affected account counts. |
| Emailed invitation | `services/invitations.ts` marks an account verified when the invitation has `invitation.emailed_at` (migration `0046`) and an address, and it is accepted for that address. `POST /api/admin/invites` sets `emailed_at` only after the invitation email was delivered, and then does not return the link to the administrator, so only the mailbox owner holds it. The `invite.redeem` event records `emailVerifiedByInvitation: true`. Invitations created before `0046`, with no address, or whose email was not delivered have no `emailed_at` and do not set the flag. |
| Explicit policy exemption | Current `auth/email-verification.ts`, administrative creation and invitation flows still permit automatic verification when the policy is explicitly disabled. SMTP failure no longer supplies an exemption. |
| Administrative recovery | `bootstrap.ts` and `scripts/promote-admin.ts` set the flag without mailbox proof. Their `instance.bootstrap` and `user.promote_cli` events establish administrative actions, not address ownership. |
| SDK administrative routes | Installed Better Auth admin creation/update endpoints can accept verification changes under administrator permissions. They are not covered by OCI's authentication audit-path map. |
| SSO | OCI does not configure the installed SSO plugin's `trustEmailVerified` option. Account links, successful SSO sessions and present provider settings do not prove historical mailbox verification. Account-linking trust and provider-domain verification are different concepts. Shared delivery callbacks could also apply historical exemptions to new SSO users. |
| Verification-token completion | Installed `better-auth/dist/api/routes/email-verification.mjs` validates a signed, expiring JWT before updating the account. These email tokens are stateless; the `verification` table is not a ledger of completed email verification. |

Relevant current source: `apps/api/src/auth/{index,audit,email-verification}.ts`,
`apps/api/src/{bootstrap.ts,scripts/promote-admin.ts}`,
`apps/api/src/services/{admin-users/mutations,invitations,audit}.ts`, and
`packages/db/src/schema/{auth,usage}.ts`.

## Why the audit log is not a receipt

`auth/audit.ts` classifies HTTP 2xx/3xx as success. The installed verification
route can redirect invalid or expired tokens to a callback URL with an error;
that HTTP outcome can therefore produce `auth.email.verified.success`. An
already-verified account can also receive a successful response without a new
verification transition. This is source-level evidence of an audit limitation,
not a count of misleading events in a deployed instance.

Account-linked events with matching addresses are useful investigation
candidates, but there is no explicit stored method/address/transition receipt.
Audit writes are best-effort, and email-verification events are not protected
from normal audit retention. Administrative creation does not establish mailbox ownership. Nor does
redeeming an invitation whose link the administrator was shown (no address, no
delivered email, or created before migration `0046`); one emailed to the address
does, and is recorded as `emailVerifiedByInvitation: true` on `invite.redeem`.

## Optional aggregate-only inspection

Not executed. Under separately approved read-only access, bind an explicit
start/end window and set a statement timeout in a read-only transaction. This
query measures **evidence availability**, not verified-user counts. It returns
no account identifiers or addresses:

```sql
SELECT a.action, a.metadata->>'status' AS http_status,
       count(*) AS events,
       count(a.actor_user_id) AS actor_linked_events,
       count(*) FILTER (
         WHERE u.id IS NOT NULL AND a.actor_email = u.email
       ) AS current_email_matching_events
FROM audit_log a
LEFT JOIN "user" u ON u.id = a.actor_user_id
WHERE a.created_at >= $1::timestamptz
  AND a.created_at <  $2::timestamptz
  AND a.action IN (
    'auth.email.verified.success', 'auth.email.verified.failure',
    'user.create', 'invite.redeem',
    'instance.bootstrap', 'user.promote_cli'
  )
GROUP BY a.action, a.metadata->>'status';
```

## Owner decisions before access changes

1. Define accepted evidence: mailbox-token completion, explicitly trusted IdP
   assertions, or documented administrative attestation. Keep those distinct.
2. Decide how to handle unknown-provenance accounts while preserving a tested
   administrator recovery path. Do not bulk reset flags or revoke sessions from
   timestamps, missing logs, or a boolean alone.
3. If stronger future evidence is required, design address-bound completion
   receipts, separate administrative exemptions, retention rules and SDK-admin
   audit coverage. Correcting audit labels alone cannot reconstruct history.

Existing flags and sessions remain unchanged. The source review is complete;
production evidence collection and any re-verification policy remain separate,
owner-approved work. See [Identity and access](../admin/identity.md) and the
[remediation/release plan](remediation-release-plan.md).
