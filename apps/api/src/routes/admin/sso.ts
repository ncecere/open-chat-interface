import { X509Certificate } from 'node:crypto';
import { desc, eq, schema } from '@oci/db';
import {
  claimMappingsSchema,
  createSsoProviderSchema,
  type SsoProviderSummary,
  USER_ROLES,
} from '@oci/shared';
import { APIError } from 'better-auth/api';
import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { loadEnv } from '../../config/env.js';
import { db } from '../../db/index.js';
import { conflict, notFound, validationFailed } from '../../lib/errors.js';
import { type AppBindings, currentUser } from '../../middleware/context.js';
import { parseBody, parseChanges } from '../../middleware/validate.js';
import { recordAudit } from '../../services/audit.js';
import { getDefaultOrganizationId } from '../../services/organization.js';
import { diffUpdate } from '../../services/settings-diff.js';

export const ssoRoutes = new Hono<AppBindings>();

const env = loadEnv();

/**
 * Better Auth 1.6 fetches an OIDC discovery document only from a trusted
 * origin (APP_URL plus AUTH_TRUSTED_ORIGINS), public or private: an SSRF
 * guard. Checked here, with the same predicate the SSO plugin uses, so the
 * admin is told which origin to add instead of getting a generic 500.
 */
async function assertDiscoveryTrusted(discoveryEndpoint: string): Promise<void> {
  const context = await auth.$context;
  if (context.isTrustedOrigin(discoveryEndpoint)) return;
  const origin = new URL(discoveryEndpoint).origin;
  throw validationFailed(
    `OCI only contacts identity providers listed in AUTH_TRUSTED_ORIGINS. Add ${origin} to AUTH_TRUSTED_ORIGINS on every API replica, restart them, then add this provider again.`,
    { path: ['issuer'], origin },
  );
}

/**
 * The SSO plugin reports a configuration it refuses (discovery that fails, an
 * unreachable or private endpoint, an invalid certificate) as an APIError. OCI's
 * error handler would turn that into a bare 500; pass the plugin's own reason
 * back as a validation error instead. Server faults are left alone.
 */
async function registerWithPlugin(
  body: NonNullable<Parameters<typeof auth.api.registerSSOProvider>[0]>['body'],
  headers: Headers,
): Promise<void> {
  try {
    await auth.api.registerSSOProvider({ body, headers });
  } catch (error) {
    if (error instanceof APIError && error.statusCode < 500) {
      const detail = error.body as { code?: string; message?: string } | undefined;
      throw validationFailed(detail?.message ?? error.message, { code: detail?.code });
    }
    throw error;
  }
}

/**
 * The IdP's signing certificate, which every SAML response is checked
 * against. "this is not a certificate" used to be accepted, and the problem
 * only surfaced as failed sign-ins. Accepts PEM, or the bare base64 body that
 * IdP metadata carries.
 */
function assertIdpCertificate(value: string): void {
  const body = value.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----`;
  try {
    new X509Certificate(pem);
  } catch {
    throw validationFailed(
      "The IdP certificate is not a valid X.509 certificate. Paste the signing certificate from the identity provider's metadata (PEM, or its base64 body).",
      { path: ['idpCertificate'] },
    );
  }
}

function callbackUrl(providerId: string, kind: 'oidc' | 'saml'): string {
  return kind === 'saml'
    ? `${env.APP_URL}/api/auth/sso/saml2/sp/acs/${providerId}`
    : `${env.APP_URL}/api/auth/sso/callback/${providerId}`;
}

function metadataUrl(providerId: string, kind: 'oidc' | 'saml'): string | null {
  return kind === 'saml'
    ? `${env.APP_URL}/api/auth/sso/saml2/sp/metadata?providerId=${providerId}`
    : null;
}

ssoRoutes.get('/providers', async (c) => {
  const rows = await db
    .select()
    .from(schema.ssoProvider)
    .orderBy(desc(schema.ssoProvider.createdAt));

  const providers: SsoProviderSummary[] = rows.map((row) => {
    const kind = row.kind === 'saml' ? 'saml' : 'oidc';
    return {
      id: row.id,
      providerId: row.providerId,
      label: row.label || row.providerId,
      kind,
      enabled: row.enabled,
      jitProvisioning: row.jitProvisioning,
      trustedForLinking: row.trustedForLinking,
      allowedDomains: row.allowedDomains,
      defaultRole: row.defaultRole as SsoProviderSummary['defaultRole'],
      claimRoleMappings: row.claimRoleMappings,
      requireRoleMatch: row.requireRoleMatch,
      roleRequiredMessage: row.roleRequiredMessage,
      claimMappings: row.claimMappings,
      autoRedirect: row.autoRedirect,
      issuer: row.issuer,
      metadataUrl: metadataUrl(row.providerId, kind),
      callbackUrl: callbackUrl(row.providerId, kind),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });

  return c.json({ providers });
});

ssoRoutes.post('/providers', async (c) => {
  const actor = currentUser(c);
  const input = await parseBody(c, createSsoProviderSchema);
  const organizationId = await getDefaultOrganizationId();

  const [existing] = await db
    .select({ id: schema.ssoProvider.id })
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, input.providerId))
    .limit(1);

  if (existing) throw conflict('A provider with that ID already exists');

  const domain = input.allowedDomains[0] ?? 'localhost';

  if (input.kind === 'oidc') {
    const discoveryEndpoint =
      input.discoveryUrl ?? `${input.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    await assertDiscoveryTrusted(discoveryEndpoint);
    await registerWithPlugin(
      {
        providerId: input.providerId,
        issuer: input.issuer,
        domain,
        oidcConfig: {
          clientId: input.clientId,
          clientSecret: input.clientSecret,
          discoveryEndpoint,
          scopes: input.scopes,
          pkce: input.pkce,
        },
      },
      c.req.raw.headers,
    );
  } else {
    assertIdpCertificate(input.idpCertificate);
    await registerWithPlugin(
      {
        providerId: input.providerId,
        issuer: input.issuer,
        domain,
        samlConfig: {
          entryPoint: input.entryPoint,
          cert: input.idpCertificate,
          callbackUrl: callbackUrl(input.providerId, 'saml'),
          audience: input.audience ?? env.APP_URL,
          wantAssertionsSigned: input.wantAssertionsSigned,
          signatureAlgorithm: input.signatureAlgorithm,
          digestAlgorithm: input.digestAlgorithm,
          idpMetadata: {
            entityID: input.issuer,
            cert: input.idpCertificate,
            singleSignOnService: [
              {
                Location: input.entryPoint,
                Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
              },
            ],
          },
          spMetadata: {
            entityID: input.audience ?? env.APP_URL,
            binding: 'post',
          },
        },
      },
      c.req.raw.headers,
    );
  }

  // Apply OCI-specific policy columns the plugin does not manage.
  await db
    .update(schema.ssoProvider)
    .set({
      organizationId,
      label: input.label,
      kind: input.kind,
      enabled: input.enabled,
      jitProvisioning: input.jitProvisioning,
      trustedForLinking: input.trustedForLinking,
      // The SSO plugin refuses every sign-in from a provider whose domain is
      // not verified, so a configured provider is always verified. Linking to
      // existing accounts is a separate decision, enforced by OCI from
      // trustedForLinking (auth/sso-linking.ts).
      domainVerified: true,
      allowedDomains: input.allowedDomains,
      defaultRole: input.defaultRole,
      claimRoleMappings: input.claimRoleMappings,
      requireRoleMatch: input.requireRoleMatch,
      roleRequiredMessage: input.roleRequiredMessage ?? null,
      claimMappings: input.claimMappings,
      autoRedirect: input.autoRedirect,
    })
    .where(eq(schema.ssoProvider.providerId, input.providerId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.create',
    targetType: 'sso_provider',
    targetId: input.providerId,
    metadata: { kind: input.kind, label: input.label },
  });

  return c.json({ providerId: input.providerId }, 201);
});

const policyPatchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  jitProvisioning: z.boolean().optional(),
  trustedForLinking: z.boolean().optional(),
  allowedDomains: z.array(z.string().trim().toLowerCase().max(253)).optional(),
  // Same roles as creation accepts, so a provider can be edited back to them.
  defaultRole: z.enum(USER_ROLES).optional(),
  claimRoleMappings: z
    .array(
      z.object({
        claim: z.string().trim().min(1).max(120),
        value: z.string().trim().min(1).max(200),
        role: z.enum(USER_ROLES),
      }),
    )
    .optional(),
  requireRoleMatch: z.boolean().optional(),
  roleRequiredMessage: z.string().trim().max(500).nullable().optional(),
  claimMappings: claimMappingsSchema.optional(),
  autoRedirect: z.boolean().optional(),
});

ssoRoutes.patch('/providers/:providerId', async (c) => {
  const actor = currentUser(c);
  const providerId = c.req.param('providerId');
  const patch = await parseChanges(c, policyPatchSchema);

  // The whole row, for what each changed setting was (#258).
  const [existing] = await db
    .select()
    .from(schema.ssoProvider)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .limit(1);

  if (!existing) throw notFound('SSO provider not found');

  const [updated] = await db
    .update(schema.ssoProvider)
    .set(patch)
    .where(eq(schema.ssoProvider.providerId, providerId))
    .returning();

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.update',
    targetType: 'sso_provider',
    targetId: providerId,
    // Each sent setting as it was and became: whether account linking was
    // trusted before is the question after a takeover (#258).
    metadata: { ...patch, changes: diffUpdate(existing, updated ?? existing, Object.keys(patch)) },
  });

  return c.json({ ok: true });
});

ssoRoutes.delete('/providers/:providerId', async (c) => {
  const actor = currentUser(c);
  const providerId = c.req.param('providerId');

  await db.delete(schema.ssoProvider).where(eq(schema.ssoProvider.providerId, providerId));

  await recordAudit({
    actorUserId: actor.id,
    actorEmail: actor.email,
    action: 'sso.delete',
    targetType: 'sso_provider',
    targetId: providerId,
  });

  return c.json({ ok: true });
});
