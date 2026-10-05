import { z } from 'zod';
import { USER_ROLES } from '../constants.js';

export const claimRoleMappingSchema = z.object({
  claim: z.string().trim().min(1).max(120),
  value: z.string().trim().min(1).max(200),
  role: z.enum(USER_ROLES),
});

export const claimMappingsSchema = z.object({
  email: z.string().trim().max(120).optional(),
  name: z.string().trim().max(120).optional(),
  image: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(120).optional(),
});

/**
 * An email domain such as northbrook.edu: letters, digits and hyphens in dot-
 * separated labels. "@bad domain" was stored as "@bad" and "domain".
 */
const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/,
    'Use a domain such as northbrook.edu, without @ or spaces.',
  );

const baseProviderFields = {
  providerId: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9-]+$/, 'Provider ID must be lowercase alphanumeric with dashes'),
  label: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  jitProvisioning: z.boolean().default(true),
  /** Only enable for an IdP that genuinely verifies email ownership. */
  trustedForLinking: z.boolean().default(false),
  allowedDomains: z.array(emailDomainSchema).default([]),
  defaultRole: z.enum(USER_ROLES).default('user'),
  claimRoleMappings: z.array(claimRoleMappingSchema).default([]),
  /**
   * Refuse a login that matches no role mapping, rather than granting the
   * default role. Off by default so an existing provider is unaffected by an
   * upgrade.
   */
  requireRoleMatch: z.boolean().default(false),
  roleRequiredMessage: z.string().trim().max(500).nullable().optional(),
  /** Claim names for profile fields. Empty uses the standard OIDC claim. */
  claimMappings: claimMappingsSchema.default({}),
  /** Send the sign-in page straight to this provider. */
  autoRedirect: z.boolean().default(false),
};

export const createOidcProviderSchema = z.object({
  ...baseProviderFields,
  kind: z.literal('oidc'),
  issuer: z.string().trim().url().max(500),
  clientId: z.string().trim().min(1).max(300),
  clientSecret: z.string().trim().min(1).max(500),
  discoveryUrl: z.string().trim().url().max(500).nullable().optional(),
  scopes: z.array(z.string().trim().min(1).max(60)).default(['openid', 'profile', 'email']),
  pkce: z.boolean().default(true),
});

export const createSamlProviderSchema = z.object({
  ...baseProviderFields,
  kind: z.literal('saml'),
  issuer: z.string().trim().min(1).max(500),
  entryPoint: z.string().trim().url().max(500),
  idpCertificate: z.string().trim().min(1).max(20000),
  audience: z.string().trim().min(1).max(500).nullable().optional(),
  wantAssertionsSigned: z.boolean().default(true),
  signatureAlgorithm: z.enum(['sha256', 'sha512']).default('sha256'),
  digestAlgorithm: z.enum(['sha256', 'sha512']).default('sha256'),
});

export const createSsoProviderSchema = z.discriminatedUnion('kind', [
  createOidcProviderSchema,
  createSamlProviderSchema,
]);

export const ssoProviderSummarySchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  kind: z.enum(['oidc', 'saml']),
  enabled: z.boolean(),
  jitProvisioning: z.boolean(),
  trustedForLinking: z.boolean(),
  allowedDomains: z.array(z.string()),
  defaultRole: z.enum(USER_ROLES),
  claimRoleMappings: z.array(claimRoleMappingSchema),
  requireRoleMatch: z.boolean(),
  roleRequiredMessage: z.string().nullable(),
  claimMappings: claimMappingsSchema,
  autoRedirect: z.boolean(),
  issuer: z.string(),
  metadataUrl: z.string().nullable(),
  callbackUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type CreateSsoProviderInput = z.infer<typeof createSsoProviderSchema>;
export type SsoProviderSummary = z.infer<typeof ssoProviderSummarySchema>;
export type ClaimRoleMapping = z.infer<typeof claimRoleMappingSchema>;
export type ClaimMappings = z.infer<typeof claimMappingsSchema>;
