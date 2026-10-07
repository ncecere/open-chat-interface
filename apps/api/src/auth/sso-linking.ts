import { count, eq, schema } from '@oci/db';
import { APIError } from 'better-auth/api';
import { db } from '../db/index.js';

export const SSO_LINK_REFUSED_MESSAGE =
  'An account with this email address already exists. Sign in the way you usually do: this identity provider is not trusted to sign in to existing accounts.';

/**
 * "Trust for account linking" (`sso_provider.trusted_for_linking`).
 *
 * Better Auth's SSO plugin decides linking from `domain_verified`, but it also
 * refuses every sign-in from a provider whose domain is not verified, so OCI
 * keeps that column true for every provider and enforces linking here instead.
 *
 * Called before Better Auth stores a new sign-in method (an `account` row).
 * A login through an SSO provider that is not trusted for linking may create
 * the first sign-in method of an account it has just provisioned, but may not
 * attach to an account that already exists (one that already has a password,
 * or another provider's login): a provider that does not truly verify email
 * ownership could otherwise assert somebody's address and take the account
 * over. Accounts that are not SSO logins are not affected.
 */
export async function assertSsoLinkAllowed(account: {
  providerId: string;
  userId: string;
}): Promise<void> {
  const [provider] = await db
    .select({ trustedForLinking: schema.ssoProvider.trustedForLinking })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, account.providerId))
    .limit(1);
  if (!provider || provider.trustedForLinking) return;

  const [existing] = await db
    .select({ value: count() })
    .from(schema.account)
    .where(eq(schema.account.userId, account.userId));
  if ((existing?.value ?? 0) === 0) return;

  throw new APIError('UNAUTHORIZED', {
    code: 'ACCOUNT_NOT_LINKED',
    message: SSO_LINK_REFUSED_MESSAGE,
  });
}
