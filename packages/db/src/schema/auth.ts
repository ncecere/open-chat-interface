import type { ClaimRoleMapping } from '@oci/shared';
import { boolean, index, jsonb, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_shared.js';
import { pgTable } from './_table.js';
import { organization } from './organization.js';

/**
 * Better Auth core tables. Column names follow Better Auth's expectations
 * so the Drizzle adapter can map them without custom field mappings.
 */
export const user = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    // admin plugin fields
    role: text('role').notNull().default('user'),
    banned: boolean('banned').notNull().default(false),
    banReason: text('ban_reason'),
    banExpires: timestamp('ban_expires', { withTimezone: true }),
    // OCI fields
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('user_email_unique').on(t.email), index('user_org_idx').on(t.organizationId)],
);

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    impersonatedBy: text('impersonated_by'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('session_token_unique').on(t.token), index('session_user_idx').on(t.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    idToken: text('id_token'),
    password: text('password'),
    ...timestamps(),
  },
  (t) => [
    index('account_user_idx').on(t.userId),
    uniqueIndex('account_provider_unique').on(t.providerId, t.accountId),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ...timestamps(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

/**
 * Better Auth SSO plugin table plus OCI provisioning policy columns.
 */
export const ssoProvider = pgTable(
  'sso_provider',
  {
    id: text('id').primaryKey(),
    issuer: text('issuer').notNull(),
    domain: text('domain').notNull(),
    oidcConfig: text('oidc_config'),
    samlConfig: text('saml_config'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    providerId: text('provider_id').notNull(),
    organizationId: text('organization_id').references(() => organization.id, {
      onDelete: 'cascade',
    }),
    // OCI policy columns
    label: text('label').notNull().default(''),
    kind: text('kind').notNull().default('oidc'),
    enabled: boolean('enabled').notNull().default(true),
    jitProvisioning: boolean('jit_provisioning').notNull().default(true),
    /**
     * Whether this IdP's asserted email is trusted enough to attach its login
     * to an existing account with the same address. Off by default: a provider
     * that does not truly verify ownership could otherwise take over accounts.
     */
    trustedForLinking: boolean('trusted_for_linking').notNull().default(false),
    /**
     * Read by the SSO plugin, which refuses every sign-in from a provider whose
     * domain is not verified. OCI keeps it true for every provider; linking is
     * governed by `trustedForLinking` (apps/api/src/auth/sso-linking.ts).
     */
    domainVerified: boolean('domain_verified').notNull().default(false),
    allowedDomains: jsonb('allowed_domains').$type<string[]>().notNull().default([]),
    defaultRole: text('default_role').notNull().default('user'),
    claimRoleMappings: jsonb('claim_role_mappings')
      .$type<ClaimRoleMapping[]>()
      .notNull()
      .default([]),
    /**
     * Whether a login that matches no role mapping is refused.
     *
     * Off preserves the original behaviour, where an unmatched user silently
     * receives `defaultRole` — which means everyone the identity provider will
     * authenticate gets an account. Turning this on is what makes group
     * mapping an authorisation boundary rather than a label.
     */
    requireRoleMatch: boolean('require_role_match').notNull().default(false),
    /** Shown to a refused user. Blank falls back to a generic message. */
    roleRequiredMessage: text('role_required_message'),
    /**
     * Claim names carrying profile fields. Null uses the standard OIDC claim,
     * which is right for a conforming provider and wrong for the several that
     * are not.
     */
    claimMappings: jsonb('claim_mappings')
      .$type<{ email?: string; name?: string; image?: string; subject?: string }>()
      .notNull()
      .default({}),
    /**
     * Sends the sign-in page straight here, skipping the local form.
     *
     * The form remains reachable at `/auth/login?local=1`, which is the only
     * way back in if the provider breaks.
     */
    autoRedirect: boolean('auto_redirect').notNull().default(false),
    ...timestamps(),
  },
  (t) => [uniqueIndex('sso_provider_provider_id_unique').on(t.providerId)],
);

export const invitation = pgTable(
  'invitation',
  {
    id: primaryId(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email'),
    role: text('role').notNull().default('user'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    redeemedByUserId: text('redeemed_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdByUserId: text('created_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invitation_token_hash_unique').on(t.tokenHash),
    index('invitation_email_idx').on(t.email),
  ],
);
